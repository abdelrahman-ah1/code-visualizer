class V:
    def __init__(self, name):
        self.name = name
        self.out = []

a = V("A"); b = V("B"); c = V("C")
a.out.append(b)
a.out.append(b)
b.out.append(a)
b.out.append(c)
c.out.append(c)
alias = a.out
print("done")
