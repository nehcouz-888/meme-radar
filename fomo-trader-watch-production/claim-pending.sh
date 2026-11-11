#!/usr/bin/env bash
# After parent SendToUser, claim pending alert files so the next poll stays silent.
# Usage: claim-pending.sh <eventId-or-basename>
#        claim-pending.sh --all-pending   (move ALL current pending to archive — use carefully)
set -euo pipefail
ROOT=/workspace/meme-radar-run/fomo-trader-watch
PENDING=$ROOT/alerts/pending
ARCHIVE=$ROOT/alerts/archive
QUEUE=$ROOT/alerts/queue.jsonl
mkdir -p "$ARCHIVE"
claim_one() {
  local base="$1"
  base="${base%.txt}"; base="${base%.json}"
  local ts; ts=$(date -u +%Y%m%dT%H%M%SZ)
  for ext in txt json; do
    if [ -f "$PENDING/$base.$ext" ]; then
      mv "$PENDING/$base.$ext" "$ARCHIVE/${ts}_${base}.$ext"
    fi
  done
  if [ -f "$QUEUE" ]; then
    python3 - "$QUEUE" "$base" <<'PY'
import json,sys,os,tempfile
path, eid = sys.argv[1], sys.argv[2]
rows=[]
changed=False
with open(path) as f:
  for line in f:
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except: rows.append(line); continue
    if str(r.get('eventId','')).replace('/','_') == eid or eid in str(r.get('eventId','')):
      if r.get('status') != 'delivered':
        r['status']='delivered'; r['deliveredAt']=__import__('datetime').datetime.utcnow().isoformat()+'Z'
        changed=True
    rows.append(json.dumps(r, ensure_ascii=False))
if changed:
  fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path)); os.close(fd)
  open(tmp,'w').write('\n'.join(rows)+('\n' if rows else ''))
  os.replace(tmp, path)
print('claimed', eid, 'changed', changed)
PY
  fi
}
if [ "${1:-}" = "--all-pending" ]; then
  for f in "$PENDING"/*.txt; do
    [ -e "$f" ] || continue
    claim_one "$(basename "$f" .txt)"
  done
  exit 0
fi
[ $# -ge 1 ] || { echo "usage: $0 <eventId>|--all-pending"; exit 2; }
claim_one "$1"
