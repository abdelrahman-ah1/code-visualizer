struct Node { int v; Node* next; };
int main() {
    Node* n = new Node{1, nullptr};
    n->v = 2;
    n = nullptr;
    return 0;
}
