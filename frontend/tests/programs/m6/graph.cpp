#include <vector>
struct Node { int id; std::vector<Node*> adj; };
void link(Node* a, Node* b) { a->adj.push_back(b); b->adj.push_back(a); }
int main() {
  Node* a = new Node{1, {}};
  Node* b = new Node{2, {}};
  Node* c = new Node{3, {}};
  Node* d = new Node{4, {}};
  link(a, b);
  link(b, c);
  link(c, a);
  d->adj.push_back(d);
  return 0;
}
