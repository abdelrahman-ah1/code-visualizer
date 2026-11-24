class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next
a = Node(1, Node(2))
b = a.next
b.next = Node(3)
a.next = b.next
