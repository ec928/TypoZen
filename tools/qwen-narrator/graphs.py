"""CUDA graphs for Qwen3-TTS generation: the narrator's speed.

Every frame of audio (12 a second) is one step of the 28-layer talker plus 15 tokens from the
5-layer code predictor, each run through Hugging Face's generic generate() loop. Nearly all of
that is overhead -- a frame took about 200ms at batch 1 and at batch 8 alike -- while the GPU
work behind it is around 10ms. A CUDA graph records a step's GPU work once and replays it with
one call, so the overhead goes.

Two levels, each falling back to the original code when it does not apply or fails:

  graph_code_predictor  the predictor's 15 tokens as one graph per batch size. Used whenever the
                        talker runs without its own graph (0.3.31: 2.6-2.8x faster).
  graph_talker          a whole frame -- talker, predictor, text alignment, sampling -- as one
                        graph, padded to batch 8 so that one graph serves every batch.

A graph holds the addresses of the weights it was captured with. When the weights move (design()
moves the narrator to the CPU and back) a graph replayed afterwards reads whatever now occupies
the old memory -- measured 2026-09-24: entirely different tokens. Both levels fingerprint the
weight addresses and recapture when they change, and release() drops them on purpose.
"""
import time

NEG_INF = float('-inf')

# Diagnostics only: a (frames, batch, vocab) float tensor to receive each frame's raw logits,
# set before the talker graph is captured. None in the narrator.
DEBUG_LOGITS = [None]


def _static_cache(StaticCache, config, length, batch, device, dtype):
    try:
        return StaticCache(config=config, max_cache_len=length)
    except TypeError:
        return StaticCache(config=config, max_batch_size=batch, max_cache_len=length, device=device, dtype=dtype)


def _fingerprint(module):
    return hash(tuple(p.data_ptr() for p in module.parameters()))


class _PredictorSteps(object):
    """The code predictor's 15 tokens for one frame, in fixed shapes so they can be captured."""

    def __init__(self, torch, talker, B):
        from transformers import StaticCache
        self.torch, self.cp = torch, talker.code_predictor
        cp = self.cp
        p = next(cp.parameters())
        self.n = cp.config.num_code_groups - 1
        L = self.n + 1
        self.cache = _static_cache(StaticCache, cp.config, L, B, p.device, p.dtype)
        keys = torch.arange(L, device=p.device)
        # Per step: cache positions, position ids and the causal mask (True = may attend).
        # Positions 0-1 are the prefill (talker hidden state, first code); then one each.
        self.steps = []
        for start, q in [(0, 2)] + [(g + 1, 1) for g in range(1, self.n)]:
            cpos = torch.arange(start, start + q, device=p.device)
            mask = (keys[None, :] <= cpos[:, None])[None, None].expand(B, 1, q, L).contiguous()
            self.steps.append((cpos, cpos.unsqueeze(0), mask))

    def _forward(self, embeds, k):
        cp = self.cp
        cpos, pids, mask = self.steps[k]
        h = cp.small_to_mtp_projection(embeds)
        pe = cp.model.rotary_emb(h, pids)
        for layer in cp.model.layers[: cp.config.num_hidden_layers]:
            out = layer(h, attention_mask=mask, position_ids=pids, past_key_values=self.cache,
                        output_attentions=False, use_cache=True, cache_position=cpos, position_embeddings=pe)
            h = out[0] if isinstance(out, tuple) else out
        return cp.model.norm(h)

    def run(self, inp, temperature, top_k):
        """inp (B, 2, talker hidden): the talker's hidden state and its code. Returns (B, 15)."""
        torch, cp = self.torch, self.cp
        h = self._forward(inp, 0)
        tok = _sample(torch, cp.lm_head[0](h[:, -1]).float(), temperature, top_k)
        toks = [tok]
        for g in range(1, self.n):
            h = self._forward(cp.model.codec_embedding[g - 1](tok), g)
            tok = _sample(torch, cp.lm_head[g](h[:, -1]).float(), temperature, top_k)
            toks.append(tok)
        return torch.cat(toks, dim=1)


def _sample(torch, logits, temperature, top_k):
    """Temperature, then top-k, then a draw: what generate() does with top-p at 1.0."""
    logits = logits / temperature
    kth = torch.topk(logits, top_k, dim=-1).values[..., -1:]
    logits = logits.masked_fill(logits < kth, NEG_INF)
    return torch.multinomial(torch.softmax(logits, dim=-1), 1)


def _capture(torch, run):
    """Warm up on a side stream (lazy allocations happen outside the capture), then capture."""
    side = torch.cuda.Stream()
    side.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(side):
        for _ in range(2):
            run()
    torch.cuda.current_stream().wait_stream(side)
    g = torch.cuda.CUDAGraph()
    with torch.cuda.graph(g, capture_error_mode='thread_local'):
        run()
    return g


class _Sequences(object):
    """What the talker reads from the predictor's generate(): the new tokens."""
    def __init__(self, sequences):
        self.sequences = sequences


def graph_code_predictor(model, torch, log):
    """The predictor's 15 tokens as one CUDA graph per batch size (see the module docstring).

    Same sampling as generate() is given (temperature, then top-k; top-p 1.0 is a no-op). With
    sampling off it chose the same tokens as generate() in 180 of 180 cases (2026-09-24).
    """
    talker = model.model.talker
    cp = talker.code_predictor
    inner = cp.generate
    hidden = talker.config.hidden_size
    graphs = {}
    broken = []
    captured_at = [None]

    class Graph(object):
        def __init__(self, B, temperature, top_k):
            p = next(cp.parameters())
            self.steps = _PredictorSteps(torch, talker, B)
            self.inp = torch.zeros(B, 2, hidden, device=p.device, dtype=p.dtype)
            self.out = torch.zeros(B, self.steps.n, device=p.device, dtype=torch.long)
            self.graph = _capture(torch, lambda: self.out.copy_(self.steps.run(self.inp, temperature, top_k)))

    def generate(*a, **k):
        x = k.get('inputs_embeds')
        top_p = k.get('top_p')
        covered = (not broken and not a and x is not None and x.dim() == 3 and x.shape[1] == 2
                   and k.get('max_new_tokens') == cp.config.num_code_groups - 1 and k.get('do_sample')
                   and (top_p is None or top_p >= 1.0) and k.get('top_k'))
        if not covered:
            return inner(*a, **k)
        key = (x.shape[0], float(k.get('temperature') or 1.0), int(k['top_k']))
        try:
            where = _fingerprint(cp)
            if captured_at[0] != where:
                if graphs:
                    log('code predictor: weights moved, recapturing the CUDA graphs')
                graphs.clear()
                captured_at[0] = where
            g = graphs.get(key)
            if g is None:
                t = time.time()
                g = graphs[key] = Graph(*key)
                log('code predictor: CUDA graph for batch %d captured in %.2fs' % (key[0], time.time() - t))
            g.inp.copy_(x)
            g.graph.replay()
            return _Sequences(g.out.clone())
        except Exception:
            import traceback
            broken.append(True)
            graphs.clear()
            log('code predictor: CUDA graph FAILED, using generate() from now on:\n' + traceback.format_exc())
            return inner(*a, **k)

    generate.release = graphs.clear
    cp.generate = generate


class _Result(object):
    """What the outer generate reads from the talker's: per step, (hidden states, codes)."""
    def __init__(self, hidden_states):
        self.hidden_states = hidden_states


def graph_talker(model, torch, log, batch=8, length=1024, text_max=256):
    """A whole frame as one CUDA graph: talker step, predictor, text alignment and sampling.

    Replaces the talker's generate(). Reproduces what generate() does with the settings qwen-tts
    passes: the prefill runs once through the model's own forward, eagerly; each frame then
    embeds the previous code, runs the predictor for the other 15, adds the frame's text (or
    the pad), runs the 28 layers against a static cache, and samples the next code with the
    repetition penalty, the suppressed tokens, the two-frame minimum before end-of-speech,
    temperature and top-k. Rows that have ended keep feeding end-of-speech, as generate()
    does, and the caller cuts each clip at its first one.

    Fixed shapes: `batch` rows (a smaller batch is padded with copies of its first row and the
    copies are dropped), `length` positions of prompt plus frames, `text_max` frames of trailing
    text. A request outside them, other sampling settings, or any failure goes to the original
    generate() -- after a failure, for good.
    """
    from transformers import StaticCache
    talker = model.model.talker
    inner = talker.generate
    cfg = talker.config
    H, V = cfg.hidden_size, cfg.vocab_size
    eos = cfg.codec_eos_token_id
    state = {'frame': None, 'key': None, 'at': None}
    broken = []

    class Frame(object):
        def __init__(self, key):
            temperature, top_k, rp, sub_temperature, sub_top_k, min_new, suppress = key
            p = next(talker.parameters())
            dev, dt, B, L = p.device, p.dtype, batch, length
            self.cache = _static_cache(StaticCache, cfg, L, B, dev, dt)
            self.pred = _PredictorSteps(torch, talker, B)
            self.n = self.pred.n
            self.keys = torch.arange(L, device=dev)
            self.tok = torch.zeros(B, 1, device=dev, dtype=torch.long)
            self.past = torch.zeros(B, 1, H, device=dev, dtype=dt)
            self.gs = torch.zeros(1, device=dev, dtype=torch.long)       # frame number (generation_step)
            self.pos = torch.zeros(1, device=dev, dtype=torch.long)      # cache position
            self.cnt = torch.zeros(1, device=dev, dtype=torch.long)      # codes sampled so far
            self.rope = torch.zeros(B, 1, device=dev, dtype=torch.long)  # rope_deltas from the prefill
            self.valid = torch.ones(B, L, device=dev, dtype=torch.bool)  # False on left padding
            self.trailing = torch.zeros(B, text_max, H, device=dev, dtype=dt)
            self.tlen = torch.zeros(1, device=dev, dtype=torch.long)
            self.pad = torch.zeros(1, 1, H, device=dev, dtype=dt)
            self.presence = torch.zeros(B, V, device=dev, dtype=torch.bool)
            self.finished = torch.zeros(B, device=dev, dtype=torch.bool)
            self.suppress = torch.zeros(V, device=dev, dtype=torch.bool)
            if suppress:
                self.suppress[list(suppress)] = True
            self.eos_col = torch.zeros(V, device=dev, dtype=torch.bool)
            self.eos_col[eos] = True
            self.hist = torch.zeros(L, B, self.n + 1, device=dev, dtype=torch.long)
            self.hist_h = torch.zeros(L, B, H, device=dev, dtype=dt)
            self.settings = (temperature, top_k, rp, sub_temperature, sub_top_k, min_new)
            self.graph = _capture(torch, self.step)

        def process(self, logits):
            """generate()'s logits processors and warpers, in its order, then the draw."""
            temperature, top_k, rp, _, _, min_new = self.settings
            logits = torch.where(self.presence, torch.where(logits < 0, logits * rp, logits / rp), logits)
            logits = logits.masked_fill(self.suppress, NEG_INF)
            logits = logits.masked_fill(self.eos_col & (self.cnt < min_new), NEG_INF)
            return _sample(torch, logits, temperature, top_k)

        def take(self, nxt):
            nxt = torch.where(self.finished[:, None], torch.full_like(nxt, eos), nxt)
            self.finished |= nxt[:, 0] == eos
            self.presence.scatter_(1, nxt, True)
            self.tok.copy_(nxt)
            self.cnt += 1

        def step(self):
            _, _, _, sub_temperature, sub_top_k, _ = self.settings
            B = batch
            last = talker.model.codec_embedding(self.tok)                          # (B,1,H)
            seq = self.pred.run(torch.cat((self.past, last), dim=1), sub_temperature, sub_top_k)
            self.hist.index_copy_(0, self.gs, torch.cat((self.tok, seq), dim=1).unsqueeze(0))
            # One summed reduction over the 16 codes, exactly as the model's forward does it:
            # adding them one at a time rounds to bf16 after every add, and the result differs.
            emb = torch.cat([last] + [talker.code_predictor.model.codec_embedding[i](seq[:, i:i + 1])
                                      for i in range(self.n)], dim=1).sum(1, keepdim=True)
            text =self.trailing.index_select(1, self.gs.clamp(max=text_max - 1))
            emb = emb + torch.where(self.gs < self.tlen, text, self.pad)
            pids = (self.pos + self.rope).view(1, B, 1).expand(3, B, 1)
            mask = ((self.keys <= self.pos) & self.valid)[:, None, None, :]
            pe = talker.model.rotary_emb(emb, pids)
            h = emb
            for layer in talker.model.layers:
                out = layer(h, attention_mask=mask, position_ids=pids[0], past_key_values=self.cache,
                            output_attentions=False, use_cache=True, cache_position=self.pos,
                            position_embeddings=pe)
                h = out[0] if isinstance(out, tuple) else out
            h = talker.model.norm(h)
            self.hist_h.index_copy_(0, self.gs, h.transpose(0, 1))
            logits = talker.codec_head(h[:, -1]).float()
            if DEBUG_LOGITS[0] is not None:
                DEBUG_LOGITS[0].index_copy_(0, self.gs, logits.unsqueeze(0))
            self.take(self.process(logits))
            self.past.copy_(h)
            self.gs += 1
            self.pos += 1

    def generate(*a, **k):
        x, mask2d, trailing = k.get('inputs_embeds'), k.get('attention_mask'), k.get('trailing_text_hidden')
        pad = k.get('tts_pad_embed')
        top_p, sub_top_p = k.get('top_p'), k.get('subtalker_top_p')
        covered = (not broken and not a and x is not None and mask2d is not None and trailing is not None
                   and pad is not None and x.shape[0] <= batch and x.shape[1] <= length - 64
                   and trailing.shape[1] <= text_max and k.get('do_sample') and k.get('subtalker_dosample')
                   and (top_p is None or top_p >= 1.0) and (sub_top_p is None or sub_top_p >= 1.0)
                   and k.get('top_k') and k.get('subtalker_top_k')
                   and (k.get('eos_token_id') in (None, eos)))
        if not covered:
            return inner(*a, **k)
        key = (float(k.get('temperature') or 1.0), int(k['top_k']), float(k.get('repetition_penalty') or 1.0),
               float(k.get('subtalker_temperature') or 1.0), int(k['subtalker_top_k']),
               int(k.get('min_new_tokens') or 0), tuple(k.get('suppress_tokens') or ()))
        try:
            with torch.no_grad():
                return run(key, x, mask2d, trailing, pad, k)
        except Exception:
            import traceback
            broken.append(True)
            state['frame'] = None
            log('talker: CUDA graph FAILED, using generate() from now on:\n' + traceback.format_exc())
            return inner(*a, **k)

    def run(key, x, mask2d, trailing, pad, k):
        where = _fingerprint(talker)
        if state['at'] != where or state['key'] != key or state['frame'] is None:
            if state['frame'] is not None:
                log('talker: weights or settings changed, recapturing the CUDA graph')
            state['frame'] = None
            torch.cuda.empty_cache()
            t = time.time()
            state['frame'], state['key'], state['at'] = Frame(key), key, where
            log('talker: CUDA graph for a whole frame captured in %.2fs' % (time.time() - t))
        f = state['frame']
        B, P, T = x.shape[0], x.shape[1], trailing.shape[1]
        rows = list(range(B)) + [0] * (batch - B)                   # pad with copies of row 0
        x, mask2d, trailing = x[rows], mask2d[rows], trailing[rows]

        # Prefill: the model's own forward, once, into the graph's static cache.
        talker.rope_deltas = None
        out = talker(inputs_embeds=x, attention_mask=mask2d, past_key_values=f.cache, use_cache=True,
                     cache_position=torch.arange(P, device=x.device), trailing_text_hidden=trailing,
                     tts_pad_embed=pad, generation_step=None,
                     subtalker_dosample=True, subtalker_top_k=k['subtalker_top_k'],
                     subtalker_top_p=k.get('subtalker_top_p'), subtalker_temperature=k.get('subtalker_temperature'),
                     output_hidden_states=False, return_dict=True)
        f.presence.zero_()
        f.finished.zero_()
        f.cnt.zero_()
        f.rope.copy_(talker.rope_deltas.to(f.rope.dtype).view(batch, 1))
        f.valid.fill_(True)
        f.valid[:, :P] = mask2d.bool()
        f.trailing[:, :T] = trailing
        f.trailing[:, T:] = pad.view(1, 1, -1)
        f.tlen.fill_(T)
        f.pad.copy_(pad.view(1, 1, -1))
        f.take(f.process(out.logits[:, -1].float()))
        f.past.copy_(out.past_hidden)
        f.gs.zero_()
        f.pos.fill_(P)
        first = out.past_hidden[:B].clone()

        crit = k.get('stopping_criteria') or []
        frames = 0
        # generate() samples max_new_tokens codes: the prefill gave the first.
        room = min(length - P, int(k.get('max_new_tokens') or length) - 1)
        while frames < room:
            f.graph.replay()
            frames += 1
            if frames % 4 == 0 or frames == room:
                if bool(f.finished[:B].all()):
                    break
                if crit and any(bool(c(f.tok[:B], None).any()) for c in crit):
                    break
        if frames >= room and room == length - P and not bool(f.finished[:B].all()):
            log('talker: stopped at the %d-position limit without end-of-speech' % length)
        steps = [((first,), None)]
        for i in range(frames):
            steps.append(((f.hist_h[i, :B].unsqueeze(1).clone(),), f.hist[i, :B].clone()))
        return _Result(steps)

    def release():
        state['frame'] = None
        state['at'] = None

    generate.release = release
    talker.generate = generate
