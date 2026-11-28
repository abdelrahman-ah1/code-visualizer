rows = [[1, 2], [3, 4]]
total = 0
for r in rows:
    total += r[1]
rows[0][0] = 9
print(total)
