class N:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None

def rot_right(y):
    x = y.left
    y.left = x.right
    x.right = y
    return x

def rot_left(x):
    y = x.right
    x.right = y.left
    y.left = x
    return y

root = N(10)
root.left = N(20)
root.left.left = N(30)
root = rot_right(root)
root.right.right = N(40)
root.right.right.right = N(50)
root.right = rot_left(root.right)
print("done")
