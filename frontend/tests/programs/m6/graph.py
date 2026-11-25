class Vertex:
    def __init__(self, name):
        self.name = name
        self.edges = []

def link(a, b):
    a.edges.append(b)
    b.edges.append(a)

a = Vertex("A"); b = Vertex("B"); c = Vertex("C"); d = Vertex("D")
e = Vertex("E"); f = Vertex("F")
link(a, b)
link(b, c)
link(c, d)
link(d, a)
link(a, c)
link(e, f)
print("done")
