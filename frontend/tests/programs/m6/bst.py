class Node:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None

def insert(root, key):
    if root is None:
        return Node(key)
    if key < root.key:
        root.left = insert(root.left, key)
    else:
        root.right = insert(root.right, key)
    return root

root = None
for k in [50, 30, 70, 20, 40, 60, 80, 35, 45]:
    root = insert(root, k)
print("done")
