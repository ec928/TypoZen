# Narrator tags and cues

What you can write so the Qwen narrator changes delivery. A bracket written beside a speaker or a quotation is that line's instruction and is not spoken. `[[tag]]` anywhere in that line overrides every other instruction, and it is not spoken. With **Emotion cues** on, and no such bracket, the speech tag beside the quotation is added to the standing instruction, in the words written there.

The lines in this document were run through the speech splitter with Julie, Paul and Anna each given a voice. **Says** is the text that voice is sent. **Told** is the instruction added when Emotion cues are on. **Try it** shows that instruction under "What the narrator was told".

A tag sets delivery. It does not choose the voice. Voices are the cast, on the same window's **Cast for this book** tab. A character with no voice leaves the whole paragraph with the narrator.

## Worked lines

### A bracket the list does not know

`[clears throat]` is not a mood. The brackets are sent as written, to whoever speaks that part of the line.

At the start of the quote, Paul gets it:

```
Paul: "[clears throat] I'm going home now"
```

| Who | Says | Told |
|---|---|---|
| Narrator | Paul: | |
| Paul | [clears throat] I'm going home now | |

After the closing quote, the narrator gets it. Paul does not:

```
Paul said "good bye" [clears throat]
```

| Who | Says | Told |
|---|---|---|
| Narrator | Paul said | |
| Paul | good bye | |
| Narrator | [clears throat] | |

```
Julie told Paul "Good morning" [clears throat]
```

| Who | Says | Told |
|---|---|---|
| Narrator | Julie told Paul | |
| Julie | Good morning | |
| Narrator | [clears throat] | |

Paul is not given that line. Julie spoke it.

At the end of the quote, still inside it, Paul is sent the bracket. The model leaves that placement out:

```
Paul: "I'm going home now [clears throat]"
```

| Who | Says | Told |
|---|---|---|
| Narrator | Paul: | |
| Paul | I'm going home now [clears throat] | |

### A bracket in the line

`[giggles]` stays in Julie's line. With Emotion cues on, the words after the quote are her cue:

```
Julie said "hello world! [giggles]" in a cheery voice
```

| Who | Says | Told |
|---|---|---|
| Narrator | Julie said | |
| Julie | hello world! [giggles] | in a cheery voice |
| Narrator | in a cheery voice | |

With nobody given a voice, the narrator is sent one piece, `Julie said "hello world! [giggles]" in a cheery voice`, told `Voice the lines in quotation marks as in a cheery voice.` The quotation marks stay in that piece. A character's piece does not include them.

A bracket against the quote, with only space between, is spoken by that character:

```
[crying] "Please let me go," Anna said.
```

| Who | Says | Told |
|---|---|---|
| Anna | [crying] Please let me go, | |
| Narrator | Anna said. | |

The same happens when the tag is inside the quote. `"Please [crying] let me go," Anna said.` sends Anna `Please [crying] let me go,`.

Words between the tag and the quote leave the bracket on the narration. The quote is not given it:

```
He was [sad] for a while. "Hello," Anna said.
```

| Who | Says | Told |
|---|---|---|
| Narrator | He was [sad] for a while. | |
| Anna | Hello, | |
| Narrator | Anna said. | |

### A speech tag

```
"Get out," Anna snapped.
```

| Who | Says | Told |
|---|---|---|
| Anna | Get out, | snapped |
| Narrator | Anna snapped. | |

```
"Hello!" Anna said.
```

| Who | Says | Told |
|---|---|---|
| Anna | Hello! | Voice the lines in quotation marks as emphatic. |
| Narrator | Anna said. | |

```
"Wait—" Anna said.
```

| Who | Says | Told |
|---|---|---|
| Anna | Wait— | Voice the lines in quotation marks as breaking off. |
| Narrator | Anna said. | |

`She said "hello".` has no mood word and no exclamation. The narrator is sent the whole line, `She said "hello".`, and told nothing. "Said", "asked" and "told" add nothing. A single bracket inside the quotation is not a cue, so it does not replace "snapped" or an exclamation. Those are sent only when Emotion cues is on.

A pronoun is not a cast voice. `"Go," she whispered.` stays one narrator piece, `"Go," she whispered.`, told "whispered".

```
"Hmm." Anna was quietly snoring.
```

| Who | Says | Told |
|---|---|---|
| Anna | Hmm. | |
| Narrator | Anna was quietly snoring. | |

"Quietly" is the next sentence, so it does not colour Anna's line. With nobody given a voice, the narrator is sent the whole line and told nothing. `"Get out," Anna snapped. She was quietly snoring.` still tells Anna "snapped": that is the tag on that quote, and the snoring is the sentence after it.

## Bracket words

These are left in the spoken text, exactly as written. Capitalisation does not matter. A bracket glued to a word gets one space on that side. The model takes these tokens and not their cousins: `[crying]`, not `[weeping]`; `[whispers]`, not `[whisper]`; `[laughing]`, not `[laugh]`.

A point event is a sound at that spot: `[laughing]` `[giggles]` `[gasp]` `[sighing]` `[cough]` `[clears throat]` `[snorts]`.

A span changes the delivery from there on: `[excited]` `[sad]` `[angry]` `[amazed]` `[serious]` `[sarcastic]` `[curious]` `[mischievously]` `[crying]` `[panicked]` `[tired]` `[asmr]` `[singing]` `[whispers]` `[very slowly]` `[very fast]` `[like dracula]` `[deep and loud shouting]`.

A single bracket is that line's instruction, and it is not spoken, when it is written to the right of the speaker's name (`Anna [whispers softly], "Get out."` or `"Get out," Anna [whispers softly] said.`) or right against the quotation (`[whispers softly] "Get out," Anna said.`). It replaces the cast box of whoever reads the line -- the character's, or the narrator's when the speaker has no voice or there is none -- for that quotation only, and the speech tag is still added after it: `[Read it angry] "You're late," Tom said quietly.` is told `Read it angry, quietly`. The words around it keep their own instruction. The models' own tags, such as `[laughing]` or `[sad]`, stay in the line wherever they are, and are performed. A single bracket inside the quotation, to the left of the name, or in another sentence is read aloud, as is anything else in single brackets, such as `[check spelling]`. In ordinary prose, "she shouted" and "she whispered" are still cues, through the speech tags below, and only when Emotion cues is on.

A double bracket overrides every other instruction, and it is not spoken. `[[shouts loudly]]` works anywhere in the quotation's sentence: to the right of the name, to the left of it, or inside the quotation. It replaces the cast box, the narrator box, a speech tag that would have been added, and a single bracket on that line. A full stop inside the brackets does not end the sentence: `[[Read it plainly. Speak softly]]` is one instruction. Written after the speech tag, `"Wait—" Anna said [[hushed]].`, it is Anna's alone; the narrator reading "Anna said." keeps its own instruction. With Anna's box set to `whispers, speaks very quietly, softly, low pitched and very slowly`, the line `Anna [[shouts loudly]] sadly said "Goodbye"` tells Anna only `shouts loudly`. The words "sadly said" stay with the narrator. A double bracket in an earlier sentence does not change her line. In narration, `[[measured and quiet]] The door opened.` replaces the narrator's standing instruction for that paragraph's narration, and the brackets are not spoken. It never reaches a quotation in another sentence, whether that quotation is voiced or not.

## Speech words

With no bracket, and Emotion cues on, the speech tag that touches the quotation is added to the standing instruction. The name is left out, and so are "said", "asked" and "told". Nothing is substituted.

Who was spoken to is left out too, and so is a word that is no instruction on its own: `"Go," she told him angrily.` is told `angrily`; `"Sit down," Anna said to her brother.` and `Tom asked her again: "Where were you?"` are told nothing from the tag; `"Fine," said Tom, turning away.` is told `turning away`; `said softly; then` is `softly`; `said (coldly)` is `coldly`.

`Anna shouts, speaks loudly, forcefully, fast: "Get out..."` tells that quote `shouts, speaks loudly, forcefully, fast` when the box is empty. If Anna's box is `whispers, speaks very quietly`, and the line is `Anna sadly said "Goodbye"`, she is told `whispers, speaks very quietly, sadly`. A single bracket on the same line is used instead of the box. A double bracket is used instead of the box and the speech tag.

If the tag has no such words, the quote's punctuation is still a cue. An exclamation mark: emphatic, as in `"Hello!" Anna said.` The quote ending in an em dash, an en dash, or an ellipsis: breaking off, as in `"Wait—" Anna said.`

A paragraph with no quotation marks, and at least about seven tenths of it in italics, is read as a private thought: quieter and more inward. That stays with the narrator.

## The wording of the instruction

For narration, your instruction is used as written. When the narrator reads a quotation with its narration, a speech tag's own words go into the cue wording, after your instruction as a sentence of its own: `"Help," she whispered.` is told `Voice the lines in quotation marks as whispered.`, so only the quotation is whispered. Sent bare, `whispered` coloured the whole paragraph: Breeze read the narration at 65% of its loudness, against 114% with the cue wording (2026-10-10). A punctuation cue uses the same wording. `{cue}` is the tag's words, emphatic or breaking off. A voiced character's line is the quotation alone, so there the tag's words are added to the cast box as a clause: `Speak softly.` and `quietly` make `Speak softly, quietly`. The wording is:

> Voice the lines in quotation marks as {cue}.

Until 2026-10-09 it added "clearly but with restraint, and keep the narration around them measured", and could be edited under Emotion cues; that told the narrator to hold back on exactly these lines, so it is gone, and a setting saved with it reads as the plain wording.

A character who has a voice is told her cast box, with the speech tag added after it when there is one. Anna's snapped line, with an empty box, is told `snapped`. A character line with no cue and an empty cast box is told nothing, as the narrator is with an empty box. With a punctuation cue and an empty cast box, it is told the cue wording on its own. The same holds for Qwen and Breeze.

Designed voice-prints follow a cue less readily than Ryan and Aiden, the two speakers trained to follow one.

## With the Breeze narrator

Everything above is the same: you write the same tags, and each piece is told the same instruction. Breeze is sent the tags translated (`tools/breeze-narrator/sidecar.py`, `translate`):

| Tag | Qwen | Breeze |
|---|---|---|
| A point event: `[laughing]` `[giggles]` `[gasp]` `[sighing]` `[cough]` `[clears throat]` `[snorts]` | Left in the text; it colours the words around it | Sent as the same word in parentheses, `(laughing)`; Breeze adds the sound itself. `(snorts)` is the weakest |
| A span tag: `[sad]` `[whispers]` `[very slowly]` and the rest | Left in the text | The piece is split at the tag; the rest is told the tag's words after the instruction, as its own rendering, and the two are joined |
| Any other bracket, `[check spelling]` | Read aloud | Read aloud |
| Parentheses already in the text, `(he said)` | Read aloud | Read aloud: only the event words above are performed |
| A single bracket beside a speaker, a double bracket, a speech tag | The piece's instruction | The same instruction |

Breeze speaks in a voice from its recording and the words in it, not from a voice-print, so the note above about designed voice-prints is Qwen's.

### Strength (Breeze)

Breeze follows each instruction with a strength: Narrator Manager > Breeze > Emotion strength, 1 to 10, default 4. A number after a colon in a tag sets it for that piece: `[sad:9]`, `[[shouts loudly:9]]`, `Anna [whispers softly:2] said`. The page takes the number out before anything is sent (`takeStrength`, 09-speech.js), so Qwen gets the plain tag and the number is never spoken; the numbers-as-words step leaves bracketed text alone for the same reason. A piece with no instruction has no strength.
