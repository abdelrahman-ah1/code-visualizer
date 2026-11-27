nxt = [[2], [3], [1]]
visited = [False, False, False]
cur = 1
steps = 0
while not visited[cur - 1]:
    visited[cur - 1] = True
    cur = nxt[cur - 1][0]
    steps += 1
print(steps)
