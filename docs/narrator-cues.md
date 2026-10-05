# Narrator tags and cues

What you can write so the Qwen narrator changes delivery. A bracket is spoken by the voice that has that part of the line. It is not turned into an instruction, and it is not deleted. Leave **Emotion cues** off. That switch only adds an instruction for speech words such as "snapped", and a designed voice does not follow it.

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

`[giggles]` stays in Julie's line. Nothing is added to the instruction:

```
Julie said "hello world! [giggles]" in a cheery voice
```

| Who | Says | Told |
|---|---|---|
| Narrator | Julie said | |
| Julie | hello world! [giggles] | |
| Narrator | in a cheery voice | |

With nobody given a voice, the narrator is sent one piece, `Julie said "hello world! [giggles]" in a cheery voice`, told nothing. The quotation marks stay in that piece. A character's piece does not include them.

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
| Anna | Get out, | sharp and angry |
| Narrator | Anna snapped. | |

```
"Hello!" Anna said.
```

| Who | Says | Told |
|---|---|---|
| Anna | Hello! | emphatic |
| Narrator | Anna said. | |

```
"Wait—" Anna said.
```

| Who | Says | Told |
|---|---|---|
| Anna | Wait— | breaking off |
| Narrator | Anna said. | |

`She said "hello".` has no mood word and no exclamation. The narrator is sent the whole line, `She said "hello".`, and told nothing. "Said", "asked" and "told" add nothing. A bracket is not an instruction, so it does not replace "snapped" or an exclamation. Those are sent only when Emotion cues is on.

A pronoun is not a cast voice. `"Go," she whispered.` stays one narrator piece, `"Go," she whispered.`, told "whispered, hushed".

```
"Hmm." Anna was quietly snoring.
```

| Who | Says | Told |
|---|---|---|
| Anna | Hmm. | |
| Narrator | Anna was quietly snoring. | |

"Quietly" is the next sentence, so it does not colour Anna's line. With nobody given a voice, the narrator is sent the whole line and told nothing. `"Get out," Anna snapped. She was quietly snoring.` still tells Anna "sharp and angry": "snapped" is the tag on that quote, and the snoring is the sentence after it.

## Bracket words

These are left in the spoken text, exactly as written. Capitalisation does not matter. A bracket glued to a word gets one space on that side. The model takes these tokens and not their cousins: `[crying]`, not `[weeping]`; `[whispers]`, not `[whisper]`; `[laughing]`, not `[laugh]`.

A point event is a sound at that spot: `[laughing]` `[giggles]` `[gasp]` `[sighing]` `[cough]` `[clears throat]` `[snorts]`.

A span changes the delivery from there on: `[excited]` `[sad]` `[angry]` `[amazed]` `[serious]` `[sarcastic]` `[curious]` `[mischievously]` `[crying]` `[panicked]` `[tired]` `[asmr]` `[singing]` `[whispers]` `[very slowly]` `[very fast]` `[like dracula]` `[deep and loud shouting]`.

Anything else in brackets, such as `[check spelling]`, is also read aloud. It is not on the model's list. In ordinary prose, "she shouted" and "she whispered" are still cues, through the speech tags below, and only when Emotion cues is on.

## Speech words

With no bracket, the speech tag that touches the quotation supplies the cue. The first match in this list wins. A verb wins over an adverb. `"Get out," Anna snapped.` above is the worked case for the first of these.

| In the speech tag | Told |
|---|---|
| shout, shouted, shouting, yell, yelled, roar, roared, bellow, bellowed, scream, screamed, cried out | shouted, loud and forceful |
| whisper, whispered, whispering, murmur, murmured | whispered, hushed |
| snap, snapped, bark, barked, spat, growl, growled, hiss, hissed, snarl, snarled | sharp and angry |
| mutter, muttered, grumble, grumbled | muttered, low and grudging |
| laugh, laughed, laughing, chuckle, chuckled, giggle, giggled | amused, with a smile in the voice |
| sob, sobbed, sobbing, wept | tearful, the voice breaking |
| sigh, sighed | weary, with a sigh |
| plead, pleaded, beg, begged, implored | pleading, earnest |
| gasp, gasped | breathless, shocked |
| demand, demanded, insisted | insistent |
| stammer, stammered, stuttered | hesitant, stumbling |

| Adverb, if no verb above matched | Told |
|---|---|
| quietly, softly, gently | quiet and soft |
| angrily, furiously, savagely | angry |
| coldly, icily, flatly | cold and clipped |
| dryly, drily, wryly | dry and understated |
| sadly, mournfully, miserably | sad |
| nervously, anxiously, uneasily | nervous |
| excitedly, eagerly | excited |
| wearily, tiredly | weary |
| sarcastically, mockingly | sarcastic |
| urgently, hurriedly | urgent |

If none of those words is there, the quote's punctuation is the cue. An exclamation mark: emphatic, as in `"Hello!" Anna said.` The quote ending in an em dash, an en dash, or an ellipsis: breaking off, as in `"Wait—" Anna said.`

A paragraph with no quotation marks, and at least about seven tenths of it in italics, is read as a private thought: quieter and more inward. That stays with the narrator.

## The wording of the instruction

For narration, your instruction is used as written. When the piece has a cue, the cue wording is added after it. `{cue}` becomes the phrase in the Told column. The default wording is:

> Voice the lines in quotation marks as {cue}, clearly but with restraint, and keep the narration around them measured.

Cue wording is the fold under Emotion cues. Restore default wording puts that sentence back.

A character who has a voice is told only about that line. Your standing instruction is not added. Anna's snapped line is told: "Speak this line of dialogue as the character would say it: sharp and angry." A character line with no cue is told: "Speak this line of dialogue as the character would say it, naturally and in character."

Designed voice-prints follow a cue less readily than Ryan and Aiden, the two speakers trained to follow one.
