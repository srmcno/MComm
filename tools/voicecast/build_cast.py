"""Build the recorded cast for the game from the ElevenLabs takes (eleven_v4):
trim, level, re-encode as mono MP3, and write voices/*.js (the takes) and
src/audio/voicepack.js (the manifest, from voicepack_template.js).

The script of takes is pick.json (role, line key, variant, city, words, the
prompt sent and the voice). The raw takes live outside the repository, in
$VOICE_WORK: raw/<id>.mp3 for the cast and Brick as John Texas, and
steve/raw/<id>.mp3 for Brick as SteveM. A take whose raw file is not there is
kept as it already is in voices/ (so a later run only has to have the new ones).

  python3 tools/voicecast/build_cast.py            dry run: sizes and the listening-check flags
  python3 tools/voicecast/build_cast.py --write    write voices/ and src/audio/voicepack.js
  --drop=id,id,...                                 leave these takes out

Needs numpy, miniaudio and lameenc (pip install numpy miniaudio lameenc).
"""
import sys, os, json, math, base64, re, glob
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
WORK = os.environ.get('VOICE_WORK', '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/v4')
try:
    import numpy as np, miniaudio, lameenc
except ImportError:
    sys.path.insert(0, os.path.join(WORK, '..', 'voice', 'pylib'))
    import numpy as np, miniaudio, lameenc

RATE = {'brick': 22050, 'mutter': 22050, 'victim': 22050, 'ilsa': 16000}
KBPS = {'brick': 40, 'mutter': 32, 'victim': 32, 'ilsa': 24}
TARGET_RMS_DB = -17.0
ROLE_DB = {'brick': 0.0, 'ilsa': 1.5, 'mutter': 0.0, 'victim': 0.0}
PEAK = 10 ** (-1.0 / 20)
ORDER = {'brick': 0, 'ilsa': 1, 'mutter': 2, 'victim': 3}
FILE_MAX = 5_600_000          # bytes of JS per pack file
# Brick has two casts, both shipped: John Texas (the first v4 recording) and
# SteveM (the player picks, BRICK VOICE). Everyone else has one.
SETS = {'stevem': os.path.join(WORK, 'steve', 'raw'), 'texas': os.path.join(WORK, 'raw')}
DEFAULT_SRC = os.path.join(WORK, 'raw')

def shipped():
    """The takes already in voices/, by (set, role, key, variant, city, words)."""
    out = {}
    for f in glob.glob(os.path.join(REPO, 'voices', '*.js')):
        set_ = 'cast' if os.path.basename(f).startswith('cast-') else os.path.basename(f).split('-')[1]
        for line in open(f):
            line = line.strip()
            if not line.startswith('{"r"'): continue
            c = json.loads(line.rstrip(','))
            out[(set_, c['r'], c['k'], c['i'], c['a'], c['t'])] = c
    return out

def db(x): return 20 * math.log10(max(float(x), 1e-9))

def process(path, role):
    rate = RATE[role]
    dec = miniaudio.decode(open(path, 'rb').read(), output_format=miniaudio.SampleFormat.FLOAT32, nchannels=1, sample_rate=rate)
    x = np.frombuffer(dec.samples, dtype=np.float32).astype(np.float64)
    n = len(x)
    fr = int(rate * 0.010)
    nf = n // fr
    if nf < 3: return None
    rms = np.sqrt((x[:nf * fr].reshape(nf, fr) ** 2).mean(axis=1))
    peak_rms = rms.max()
    gate = max(peak_rms * 0.03, 10 ** (-52 / 20))
    act = np.nonzero(rms > gate)[0]
    if not len(act): return None
    a = max(0, act[0] * fr - int(rate * 0.04))
    b = min(n, (act[-1] + 1) * fr + int(rate * 0.09))
    y = x[a:b]
    seg = rms[act[0]:act[-1] + 1]
    voiced = seg[seg > peak_rms * 0.1]
    level = math.sqrt(float((voiced ** 2).mean())) if len(voiced) else peak_rms
    gain = 10 ** ((TARGET_RMS_DB + ROLE_DB[role]) / 20) / max(level, 1e-6)
    pk = float(np.abs(y).max())
    if pk * gain > PEAK: gain = PEAK / pk
    m = len(y)
    env = np.full(m, gain)
    fi, fo = int(rate * 0.005), int(rate * 0.02)
    env[:fi] *= np.arange(fi) / fi
    env[m - fo:] *= np.clip((m - np.arange(m - fo, m)) / fo, 0, 1)
    pcm = np.clip(np.round(y * env * 32767), -32767, 32767).astype('<i2')
    enc = lameenc.Encoder()
    enc.set_bit_rate(KBPS[role]); enc.set_in_sample_rate(rate); enc.set_channels(1); enc.set_quality(2)
    mp3 = enc.encode(pcm.tobytes()) + enc.flush()
    return mp3, m / rate, db(level * gain), db(pk * gain), n / rate

# ---- the listening check (speech to text), if it has been run
NUM = set('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million'.split())
def norm(s):
    s = s.lower().replace('-', ' ')
    s = re.sub(r"\[[^\]]*\]", ' ', s)
    s = re.sub(r"[^a-z0-9' ]+", ' ', s).replace("'", '')
    toks = []
    for w in s.split():
        t = '#' if (w in NUM or re.fullmatch(r'\d+', w)) else w
        if t == '#' and toks and toks[-1] == '#': continue
        toks.append(t)
    return toks
def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, p in enumerate(a, 1):
        cur = [i]
        for j, q in enumerate(b, 1): cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p != q)))
        prev = cur
    return prev[-1]
def heard():
    out = {}
    for f in [os.path.join(WORK, 'qa', 'stt_out.json'), os.path.join(WORK, 'steve', 'qa', 'stt_out.json')]:
        if os.path.exists(f):
            d = json.load(open(f))
            if 'steve' in f: out.update({('steve', k): v for k, v in d.items()})
            else: out.update({('raw', k): v for k, v in d.items()})
    return out

def main():
    write = '--write' in sys.argv
    drop = set()
    for a in sys.argv:
        if a.startswith('--drop='): drop |= set(x for x in a[7:].split(',') if x)
    pick = json.load(open(os.path.join(HERE, 'pick.json')))
    stt = heard()
    have = shipped()
    reused = 0
    clips, flags, missing, total = [], [], [], 0
    secs = {}
    jobs = []
    for o in pick:
        if o['role'] == 'brick':
            for name, src in SETS.items(): jobs.append((o, name, src))
        else: jobs.append((o, 'cast', DEFAULT_SRC))
    for o, set_, src in jobs:
        path = os.path.join(src, o['id'] + '.mp3')
        if o['id'] in drop or (set_ + ':' + o['id']) in drop: continue
        if not os.path.exists(path):
            k = None if o['key'] == 'distracted' else o['key']
            old = have.get((set_, o['role'], k, o['i'], o['a'], o['text']))
            if old:
                clips.append({**old, '_tier': o['tier'], '_set': set_}); reused += 1; total += len(old['b']) * 3 // 4
                secs[set_] = secs.get(set_, 0) + old['d']
            else: missing.append(set_ + ':' + o['id'])
            continue
        r = process(path, o['role'])
        if not r: flags.append((9, set_ + ':' + o['id'], 'SILENT', '')); continue
        mp3, dur, lvl, pk, orig = r
        total += len(mp3); secs[set_] = secs.get(set_, 0) + dur
        h = stt.get(('steve' if set_ == 'stevem' else 'raw', o['id']))
        if h is not None:
            a, b = norm(o['text']), norm(h)
            wer = lev(a, b) / max(1, len(a))
            tag = bool(re.match(r'\s*(shouting|dazed|panicked|deadpan|breathless|whispering|laughing|sighs?)\b', h.lower()))
            if wer >= 0.3 or tag: flags.append((wer, set_ + ':' + o['id'], h, o['text']))
        # the DISTRACTED exchanges are exact lines, found by their words, not a key
        clips.append({'r': o['role'], 'k': None if o['key'] == 'distracted' else o['key'], 'i': o['i'], 'a': o['a'], 't': o['text'], 'd': round(dur, 3),
                      'b': base64.b64encode(mp3).decode('ascii'), '_tier': o['tier'], '_set': set_})
    print(f'{len(clips)} clips ({reused} kept as shipped), {total / 1e6:.1f} MB mp3, {sum(len(c["b"]) for c in clips) / 1e6:.1f} MB base64; missing {len(missing)}')
    print('seconds by set', {k: round(v) for k, v in secs.items()})
    if missing: print('missing:', ' '.join(missing[:40]))
    flags.sort(key=lambda f: -f[0])
    print(f'{len(flags)} flagged by the listening check:')
    for wer, id_, h, t in flags: print(f'  {wer:.2f} {id_}\n     said: {t}\n    heard: {h}')
    if not write: return
    vdir = os.path.join(REPO, 'voices')
    os.makedirs(vdir, exist_ok=True)
    for f in os.listdir(vdir):
        if f.endswith('.js'): os.remove(os.path.join(vdir, f))
    manifest = []
    prefix = {'cast': 'cast', 'stevem': 'brick-stevem', 'texas': 'brick-texas'}
    for set_ in ['cast', 'stevem', 'texas']:
        mine = [c for c in clips if c['_set'] == set_]
        mine.sort(key=lambda c: (c['_tier'], ORDER[c['r']], c['k'] or '~', c['i'], c['a'] or ''))
        # a file per tier at most, so the lines heard most can be fetched first
        files, cur, size, tier = [], [], 0, None
        for c in mine:
            t = c['_tier']
            line = json.dumps({k: v for k, v in c.items() if not k.startswith('_')}, ensure_ascii=True)
            if cur and (size + len(line) > FILE_MAX or (t != tier and size > FILE_MAX * 0.35)):
                files.append((tier, cur)); cur, size = [], 0
            if not cur: tier = t
            cur.append(line); size += len(line) + 2
        if cur: files.append((tier, cur))
        for n, (t, lines) in enumerate(files):
            name = f'{prefix[set_]}-{n}.js'
            what = 'the recorded cast' if set_ == 'cast' else 'Brick, as ' + ('SteveM' if set_ == 'stevem' else 'John Texas')
            body = ['// ' + name + ' - NUKEHAUS, ' + what + ', part ' + str(n + 1) + ' of ' + str(len(files)) + '.',
                    '// GENERATED from ElevenLabs takes (eleven_v4): do not edit by hand. See src/audio/voicepack.js.',
                    '(globalThis.NUKEHAUS_VOICES = globalThis.NUKEHAUS_VOICES || []).push({ set: ' + json.dumps(set_) + ', clips: [']
            body += [l + ',' for l in lines]
            body += [']});', '']
            open(os.path.join(vdir, name), 'w').write('\n'.join(body))
            manifest.append({'src': 'voices/' + name, 'set': set_, 'tier': t, 'clips': len(lines), 'bytes': os.path.getsize(os.path.join(vdir, name))})
            print('wrote', name, len(lines), 'clips', manifest[-1]['bytes'] // 1024, 'KB', 'tier', t)
    js = open(os.path.join(HERE, 'voicepack_template.js')).read()
    js = js.replace('/*FILES*/', ',\n'.join('  ' + json.dumps(m) for m in manifest))
    open(os.path.join(REPO, 'src', 'audio', 'voicepack.js'), 'w').write(js)
    print('wrote src/audio/voicepack.js', len(manifest), 'files')

main()
