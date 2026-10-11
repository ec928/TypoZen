"""Creates a comprehensive 19-archetype voice cast in Breeze TTS.

Each archetype is generated via Breeze's voice designer using its canonical acoustic
description, then saved permanently into the Breeze voices library
(TypoZen_Cache_Portable\\extensions\\BreezeTTS\\voices).

A repertory_catalog.json file is also produced, mapping each voice archetype to
gender, register, temperament, and representative literary characters (e.g., Dune, Matter).
"""
import os
import sys
import time
import json
import shutil
import re

HERE = os.path.dirname(os.path.abspath(__file__))
# Default root in TypoZen portable/installed cache
CACHE_DEFAULT = os.path.expandvars(r'%LOCALAPPDATA%\TypoZen_Cache_Portable\extensions\BreezeTTS')
if not os.path.isdir(CACHE_DEFAULT):
    CACHE_DEFAULT = os.path.expandvars(r'%LOCALAPPDATA%\TypoZen\extensions\BreezeTTS')

ROOT = os.path.abspath(CACHE_DEFAULT)
CACHE_DIR = os.path.join(ROOT, 'narration')
VOICES_DIR = os.path.join(ROOT, 'voices')
MODELS_DIR = os.path.join(ROOT, 'model')
CODE_DIR = os.path.join(ROOT, 'breeze-tts')

# Set environment before torch import
COMPILED_DIR = os.path.join(ROOT, 'compiled')
os.environ['TORCHINDUCTOR_CACHE_DIR'] = os.path.join(COMPILED_DIR, 'inductor')
os.environ['TRITON_CACHE_DIR'] = os.path.join(COMPILED_DIR, 'triton')
os.environ['HF_HOME'] = os.path.join(ROOT, 'hf')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
sys.dont_write_bytecode = True

# Import sidecar
sys.path.insert(0, HERE)
from sidecar import Narrator, DESIGN_TEXT, PREVIEW_TEXT, SAMPLE_RATE

ARCHETYPES = [
    {
        "id": "hero-youth-m",
        "name": "Hero / Youth (Male)",
        "gender": "male",
        "age": "youth",
        "description": "A young male, 16 to 18 years old. Clear bright tenor, thoughtful, observant, earnest, with sharp and intelligent diction.",
        "characters": ["Paul Atreides (Dune)", "Prince Oramen (Matter)", "Young heroes", "Squires"]
    },
    {
        "id": "noble-matriarch-f",
        "name": "Noble Matriarch (Female)",
        "gender": "female",
        "age": "mature",
        "description": "An aristocratic woman in her late 30s with a soft, melodious contralto voice. Composed, serene, poised, with quiet penetrating authority.",
        "characters": ["Lady Jessica (Dune)", "Djan Seriy Anaplian in court (Matter)", "Diplomats", "Queens"]
    },
    {
        "id": "ruler-commander-m",
        "name": "Ruler / Commander (Male)",
        "gender": "male",
        "age": "mature",
        "description": "A noble, seasoned ruler in his late 40s with a deep, resonant baritone. Charismatic, dignified, with weary gravity and natural command.",
        "characters": ["Duke Leto Atreides (Dune)", "King Haus (Matter)", "Fleet Admirals", "Kings"]
    },
    {
        "id": "crone-inquisitor-f",
        "name": "Crone / Inquisitor (Female)",
        "gender": "female",
        "age": "elder",
        "description": "An elderly woman over 65 with a dry, raspy, crackling voice. Sharp biting cadences, cold imperious severity and ancient authority.",
        "characters": ["Reverend Mother Mohiam (Dune)", "High Priestesses", "Witches", "Dowagers"]
    },
    {
        "id": "veteran-soldier-m",
        "name": "Veteran Soldier (Male)",
        "gender": "male",
        "age": "mature",
        "description": "A battle-scarred warrior in his 40s. Rough gravelly baritone with poetic cadence and sudden fierce warmth.",
        "characters": ["Gurney Halleck (Dune)", "Veteran Captains", "Mercenaries", "Sergeants"]
    },
    {
        "id": "servant-companion-m",
        "name": "Servant / Companion (Male)",
        "gender": "male",
        "age": "mature",
        "description": "An earthy, working-class realist in his 30s. Dry, grounded, candid, with warm common-sense cadence and dry wit.",
        "characters": ["Choubris Holse (Matter)", "Duncan Idaho (Dune)", "Faithful retainers", "Sidekicks"]
    },
    {
        "id": "maid-attendant-f",
        "name": "Maid / Attendant (Female)",
        "gender": "female",
        "age": "mature",
        "description": "A practical, warm, grounded woman in her 40s. Bustling, caring yet firm, with a slightly maternal, candid delivery.",
        "characters": ["Housekeepers", "Maids", "Tavern keepers", "Female retainers"]
    },
    {
        "id": "guard-sentry-m",
        "name": "Guard / Sentry (Male)",
        "gender": "male",
        "age": "young adult",
        "description": "A gruff, vigilant soldier in his late 20s. Blunt, barking, no-nonsense military brevity and sharp defensive tone.",
        "characters": ["Palace guards", "Sentries", "Watchmen", "Foot soldiers"]
    },
    {
        "id": "fierce-warrior-f",
        "name": "Fierce Warrior (Female)",
        "gender": "female",
        "age": "young adult",
        "description": "A young warrior woman in her 20s. Clear, fierce, desert-hardened, direct and intense delivery with ringing clarity.",
        "characters": ["Chani (Dune)", "Djan Seriy Anaplian in combat (Matter)", "Shieldmaidens", "Rebels"]
    },
    {
        "id": "arrogant-noble-m",
        "name": "Arrogant Noble (Male)",
        "gender": "male",
        "age": "young adult",
        "description": "A youthful noble in his early 20s. High-strung tenor, petulant, frantic, proud, theatrical and slightly insecure.",
        "characters": ["Feyd-Rautha (Dune)", "Prince Ferbin (Matter)", "Spoiled princes", "Vain rivals"]
    },
    {
        "id": "scheming-courtier-m",
        "name": "Scheming Courtier (Male)",
        "gender": "male",
        "age": "mature",
        "description": "A smooth, oily advisor in his 40s with hypocritical warmth. Polished, soft-spoken, subtly sinister and treacherous.",
        "characters": ["General Tyl Loesp (Matter)", "Count Fenring (Dune)", "Whispering viziers", "Corrupt ministers"]
    },
    {
        "id": "scholar-mentat-m",
        "name": "Scholar / Mentat (Male)",
        "gender": "male",
        "age": "elder",
        "description": "An elderly intellectual in his 60s. Dry, precise, calculating, clinical, with gravelly intellectual diction.",
        "characters": ["Thufir Hawat (Dune)", "Inceptors and Scholars (Matter)", "Philosophers", "Librarians"]
    },
    {
        "id": "twisted-minion-m",
        "name": "Twisted Minion (Male)",
        "gender": "male",
        "age": "adult",
        "description": "A twisted, sadistic minion. High-pitched, sibilant, purring whisper, gloating, theatrical and cruel.",
        "characters": ["Piter De Vries (Dune)", "Poisoners", "Sadistic interrogators", "Spies"]
    },
    {
        "id": "tyrant-overlord-m",
        "name": "Tyrant / Overlord (Male)",
        "gender": "male",
        "age": "mature",
        "description": "An immense, decadent villain with a deep rumbling bass. Heavy, guttural, menacing, tyrannical and terrifying.",
        "characters": ["Baron Vladimir Harkonnen (Dune)", "Warlords", "Galactic tyrants", "Beast lords"]
    },
    {
        "id": "nomad-chieftain-m",
        "name": "Nomad Chieftain (Male)",
        "gender": "male",
        "age": "mature",
        "description": "A weathered desert chieftain in his 50s. Deep gravelly baritone, sand-blown, solemn, reverent, grave and practical.",
        "characters": ["Stilgar (Dune)", "Clan Naibs", "Mountain guides", "Frontier marshals"]
    },
    {
        "id": "sorrowful-healer-m",
        "name": "Sorrowful Healer (Male)",
        "gender": "male",
        "age": "mature",
        "description": "A gentle, sorrowful doctor. Soft-spoken with a melancholy flutter and heavy, hesitant, weary grief.",
        "characters": ["Dr. Wellington Yueh (Dune)", "Defeated emissaries", "Gentle healers", "Tragic informants"]
    },
    {
        "id": "synthetic-drone-x",
        "name": "Synthetic Drone (Neutral)",
        "gender": "neutral",
        "age": "machine",
        "description": "A hyper-crisp, formal, slightly clipped neutral mid-register cadence. Ultra-articulate, unflappable, with dry understated wit.",
        "characters": ["Drone Sisela Ytheleus (Matter)", "Drone Mertis (Matter)", "Culture Minds", "Androids", "Ship AIs"]
    },
    {
        "id": "ingenue-ward-f",
        "name": "Ingenue / Ward (Female)",
        "gender": "female",
        "age": "youth",
        "description": "A young gentle woman around 20 years old. Clear, sincere, lyrical soprano, sweet, innocent, with curious melodic delivery.",
        "characters": ["Princesses", "Gentle wards", "Young maidens", "Romantic heroines"]
    },
    {
        "id": "alien-emissary-x",
        "name": "Alien Emissary (Neutral)",
        "gender": "neutral",
        "age": "alien",
        "description": "A resonant, spacious, slightly echoing, calm, ancient, measured and enigmatic other-worldly cadence.",
        "characters": ["Morthanveld Emissaries (Matter)", "The Oct (Matter)", "Ancient cosmic entities", "Telepaths"]
    }
]

def main():
    print("=" * 60)
    print("  TypoZen Repertory Voice Ensemble Generator (Breeze TTS)")
    print("=" * 60)
    print(f"Target Voices Directory: {VOICES_DIR}")
    print(f"Total Archetypes to Generate: {len(ARCHETYPES)}")
    os.makedirs(VOICES_DIR, exist_ok=True)

    print("\n[1/3] Loading Breeze TTS model...")
    t0 = time.time()
    narrator = Narrator(CACHE_DIR, models=MODELS_DIR, code=CODE_DIR)
    narrator.load()
    print(f"  Model loaded in {time.time() - t0:.1f}s (mode: {narrator.mode})")

    print("\n[2/3] Generating voice archetypes...")
    catalog = []
    
    for idx, arch in enumerate(ARCHETYPES, 1):
        vid = arch["id"]
        vname = arch["name"]
        target_dir = os.path.join(VOICES_DIR, vid)
        
        # Check if voice already exists
        if os.path.isdir(target_dir) and os.path.isfile(os.path.join(target_dir, 'reference.wav')):
            print(f"  [{idx}/{len(ARCHETYPES)}] {vname} ({vid}) already exists. Updating metadata...")
            meta_path = os.path.join(target_dir, 'meta.json')
            meta = {
                "name": vname,
                "description": arch["description"],
                "made": "archetype_generator",
                "gender": arch["gender"],
                "age": arch["age"],
                "transcript": DESIGN_TEXT
            }
            with open(meta_path, 'w', encoding='utf-8') as f:
                json.dump(meta, f, indent=2)
            catalog.append(dict(arch, voice_id=vid, path=target_dir))
            continue
            
        print(f"  [{idx}/{len(ARCHETYPES)}] Designing: {vname}...")
        t_start = time.time()
        
        # Design candidate
        seed = int(hash(vid) & 0x7FFFFFFF) % 100000
        audio = narrator._generate(DESIGN_TEXT, told=arch["description"], seed=seed)
        
        # Save directly as kept voice
        os.makedirs(target_dir, exist_ok=True)
        import soundfile as sf
        ref_wav = os.path.join(target_dir, 'reference.wav')
        sf.write(ref_wav, audio, SAMPLE_RATE, subtype='PCM_16')
        
        # Write metadata
        meta = {
            "name": vname,
            "description": arch["description"],
            "made": "archetype_generator",
            "gender": arch["gender"],
            "age": arch["age"],
            "transcript": DESIGN_TEXT
        }
        with open(os.path.join(target_dir, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2)
            
        # Generate standard preview line
        narrator._sample_line(target_dir)
        
        elapsed = time.time() - t_start
        print(f"    -> Saved '{vid}' in {elapsed:.1f}s")
        catalog.append(dict(arch, voice_id=vid, path=target_dir))

    print("\n[3/3] Saving Repertory Catalog...")
    catalog_path = os.path.join(VOICES_DIR, 'repertory_catalog.json')
    with open(catalog_path, 'w', encoding='utf-8') as f:
        json.dump({
            "generated_at": time.strftime('%Y-%m-%d %H:%M:%S'),
            "engine": "Breeze-TTS-2",
            "total_archetypes": len(catalog),
            "archetypes": catalog
        }, f, indent=2)
    print(f"  Catalog saved to: {catalog_path}")

    # Reload voices in narrator
    narrator.reload_voices()
    print("\nAll 19 voice archetypes generated and registered successfully!")
    print("=" * 60)

if __name__ == '__main__':
    main()
