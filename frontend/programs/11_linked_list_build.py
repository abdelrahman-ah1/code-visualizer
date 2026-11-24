class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next
head = None
for v in [3, 2, 1]:
    head = Node(v, head)
cur = head
while cur is not None:
    cur = cur.next
