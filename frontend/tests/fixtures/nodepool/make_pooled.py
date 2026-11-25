"""Experimental node-pool encoding. Not production. heap {id: node} -> {id: pool_index}; pool holds each distinct node once."""
import json, gzip, sys, glob, os, random
def canon(x): return json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def encode(trace):
    pool, index = [], {}          # index: exact canonical text -> position (dict equality = full text compare, no digest)
    events = []
    for e in trace['events']:
        e2 = dict(e)
        if 'heap' in e:
            links = {}
            for nid, node in e['heap'].items():
                k = canon(node)
                i = index.get(k)
                if i is None:
                    i = index[k] = len(pool); pool.append(node)
                links[nid] = i
            e2['heap'] = links
        events.append(e2)
    out = dict(trace); out['events'] = events
    out['encoding'] = 'node-pool/1'; out['node_pool'] = pool
    return out
def decode(enc):
    pool = enc['node_pool']
    out = {k: v for k, v in enc.items() if k not in ('encoding', 'node_pool')}
    ev = []
    for e in enc['events']:
        e2 = dict(e)
        if 'heap' in e: e2['heap'] = {nid: pool[i] for nid, i in e['heap'].items()}
        ev.append(e2)
    out['events'] = ev
    return out
def size(x): return len(json.dumps(x, separators=(',', ':')))
def gz(x): return len(gzip.compress(json.dumps(x, separators=(',', ':')).encode(), 6))
if __name__ == '__main__':
    files = sorted(glob.glob('/tmp/stress/delta/*.json') + glob.glob('/tmp/stress/t*.json') + glob.glob('/tmp/gui/frontend/public/examples/cpp_*.trace.json') + glob.glob('/tmp/stress/*.json'))
    seen = set()
    for f in files:
        if f in seen: continue
        seen.add(f)
        try: t = json.load(open(f))
        except Exception: continue
        if not isinstance(t, dict) or not t.get('events'): continue
        enc = encode(t); dec = decode(json.loads(json.dumps(enc)))   # through real JSON round trip
        ok = canon(dec) == canon(t)
        full, pl = size(t), size(enc)
        print(f"{os.path.basename(f)[:34]:34} ev={len(t['events']):5} equal={ok} full={full/1e6:7.2f}MB pool={pl/1e6:6.2f}MB ({pl/full*100:5.1f}%) gz_full={gz(t)/1e6:5.2f} gz_pool={gz(enc)/1e6:5.2f} unique={len(enc['node_pool'])}", flush=True)
