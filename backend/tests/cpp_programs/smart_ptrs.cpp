#include <memory>
struct U { int k; std::unique_ptr<U> nxt; };
struct Node { int v; Node* next; };
int main() {
  auto a = std::make_unique<U>(); a->k = 1;
  a->nxt = std::make_unique<U>(); a->nxt->k = 2;
  std::shared_ptr<Node> s = std::make_shared<Node>(); s->v = 3; s->next = nullptr;
  return a->k + s->v;
}
