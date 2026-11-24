#include <iostream>

struct Node {
    int value;
    Node* next;
};

Node* push_front(Node* head, int value) {
    return new Node{value, head};
}

// Swap the first two nodes and return the new head.
Node* swap_first_two(Node* head) {
    if (head == nullptr || head->next == nullptr) return head;
    Node* second = head->next;
    head->next = second->next;
    second->next = head;
    return second;
}

int main() {
    Node* head = nullptr;
    for (int i = 3; i >= 1; i--) {
        head = push_front(head, i * 10);
    }
    head = swap_first_two(head);
    for (Node* n = head; n != nullptr; n = n->next) {
        std::cout << n->value << " ";
    }
    std::cout << "\n";
    while (head != nullptr) {
        Node* next = head->next;
        delete head;
        head = next;
    }
    return 0;
}
