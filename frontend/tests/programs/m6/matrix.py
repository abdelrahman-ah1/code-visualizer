grid = [[0, 1, 0], [1, 0, 1], [0, 1, 0]]
total = 0
for row in grid:
    for cell in row:
        total += cell
grid[1][1] = total
print(total)
