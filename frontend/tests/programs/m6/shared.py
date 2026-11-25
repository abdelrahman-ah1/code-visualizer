class V:
    def __init__(self, name):
        self.name = name
        self.out = []

a = V("A"); b = V("B")
shared = [a, b]
a.out = shared
b.out = shared
print("done")
