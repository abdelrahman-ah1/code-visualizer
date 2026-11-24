#include <iostream>
struct Node { int v; Node* next; };
int main() {
    Node* n = new Node{1, nullptr};
    delete n;
    std::cout << n->v << "\n";
    return 0;
}
