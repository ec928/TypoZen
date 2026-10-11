# TypoZen Emotion & Narrator Tagging Test Suite

This file tests the updated strict positional rules for voice instructions and performative audio cues in TypoZen and Breeze TTS.

---

### 1. In-Quote Instructions `[ ]`
Instructions inside quotes apply exclusively to dialogue, starting from their exact placement.

"[Angry] Get out of this house and do not come back!" Anna said.

"I am furious with you. [Softly] But I forgive you anyway," Anna said.

"[whispers softly, speaks slowly:9] Please... just let me go," Anna said.

"First part plain. [hushed] Now quiet. [loud, shouting] Now loud!" Tom said.

---

### 2. Narrator Instructions `[ ]`
Instructions outside quotes apply exclusively to narration from where they are placed until the next narrator tag or end of paragraph.

[measured and quiet] The heavy iron door slowly creaked open. "Who is there?" Tom whispered.

"Go," Tom [wearily] said. "We cannot stay here."

[slowly] He turned towards the window. [excited, fast] Suddenly, a lightning bolt struck the courtyard!

Anna [whispers softly] said, "Get out."

---

### 3. Double Brackets `[[ ]]` (Hard Override)
Double brackets replace any standing cast instruction, global narrator instruction, or emotion cues.

[[angrily]] "You're late," Tom said quietly.

"Wait—" Anna said [[Read it plainly. Speak softly]].

[[Speak naturally as the character]] "You're late," Tom said.

[[whispered]] The ancient trees swayed silently in the cold night air.

---

### 4. Performative Audio Cues `( )`
Sound cues in round brackets are passed directly to Breeze to perform inline as non-speech audio events.

"Stop it (giggles)," Anna said.

"It is good to hear your voice again after all this time (sigh)."

"Wait (gasp)—did you hear that (clears throat)?"

Anna said, "I thought you were gone (sigh). Don't scare me like that (laughing)!"

"I have a cold today (cough)," Tom grumbled.

---

### 5. Combined Scenarios (The Grand Test)
Demonstrating exact positional switching, audio cues, and narration transitions in a single flow.

[steady, whisper] Anna said "[Angry] I am mad at you. (sigh) [Softly] But I forgive you anyway (giggles)." [excited, loud] Surprising even herself.

[slowly] Tom turned to Anna. "We have to go (gasp)."
Anna glared at Tom. "[furious] Never!"
"Go," she told Tom.
She glared at Tom. "[crying] Just leave me alone."
Anna stood up. [[resolute]] "I will do it myself," she said.

---

### 6. Natural Dialogue & Automatic Emotion Cues
Testing speech verbs, punctuation cues, and speaker attribution with Emotion cues enabled.

"Get out," Anna snapped.

"Hello!" Anna said.

"Wait—" Anna said.

"You're late," Tom said quietly.

"Fine," said Tom, turning away.
