class V:
    def __init__(self, name):
        self.name = name
        self.out = []

a = V("A"); b = V("B"); c = V("C"); d = V("D")
a.out.append(b)
a.out.append(c)
b.out.append(d)
c.out.append(d)
d.out.append(a)
d.out.append(d)
print("done")
