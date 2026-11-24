data = [5, 2, 4, 1, 3]
n = len(data)
for i in range(n):
    for j in range(n - 1 - i):
        if data[j] > data[j + 1]:
            data[j], data[j + 1] = data[j + 1], data[j]
print(data)
