class V:
    def __init__(self, name):
        self.name = name
        self.out = []
        self.seen = False

names = "ABCDEFG"
vs = {}
for n in names:
    vs[n] = V(n)
for a, b in ["AB", "AC", "BD", "CD", "DE", "EA", "FG"]:
    vs[a].out.append(vs[b])
queue = [vs["A"]]
vs["A"].seen = True
while queue:
    cur = queue.pop(0)
    nbrs = cur.out
    for nxt in nbrs:
        if not nxt.seen:
            nxt.seen = True
            queue.append(nxt)
print("done")
