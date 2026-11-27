from collections import deque

class V:
    def __init__(self, name):
        self.name = name
        self.out = []
        self.seen = False

names = "ABCDE"
vs = {}
for n in names:
    vs[n] = V(n)
for a, b in ["AB", "AC", "BD", "CD", "DE"]:
    vs[a].out.append(vs[b])
todo = deque([vs["A"]])
vs["A"].seen = True
order = []
while todo:
    cur = todo.popleft()
    order.append(cur.name)
    for nxt in cur.out:
        if not nxt.seen:
            nxt.seen = True
            todo.append(nxt)
print("".join(order))
