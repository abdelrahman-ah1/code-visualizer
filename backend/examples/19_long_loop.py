# About 1,800 events: try it with the 2000 event limit to see a large trace stay responsive.
total = 0
items = []
for i in range(600):
    total = total + i
    items.append(total)
print(total)
