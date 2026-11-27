adj = [[1, 2], [3], [3, 4], [4], []]
seen = [False] * 5
queue = [0]
seen[0] = True
order = 0
while queue:
    u = queue.pop(0)
    order += 1
    for v in adj[u]:
        if not seen[v]:
            seen[v] = True
            queue.append(v)
print(order)
