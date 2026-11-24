class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next
head = Node(1, Node(2, Node(4)))
prev = head.next
new = Node(3, prev.next)
prev.next = new
head.value = 10
tail = new.next
tail.next = head
