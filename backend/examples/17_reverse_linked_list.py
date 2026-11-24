class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next

head = Node(1, Node(2, Node(3, Node(4))))
prev = None
cur = head
while cur is not None:
    after = cur.next
    cur.next = prev
    prev = cur
    cur = after
head = prev
