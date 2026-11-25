class T:
    def __init__(self, name):
        self.name = name
        self.children = []

root = T("root")
a = T("a"); b = T("b"); c = T("c")
root.children.append(a)
root.children.append(b)
root.children.append(c)
a.children.append(T("a1"))
a.children.append(T("a2"))
c.children.append(T("c1"))
c.children.append(T("c2"))
c.children.append(T("c3"))
print("done")
