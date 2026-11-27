#include <iostream>
#include <stack>

struct Node {
    int value;
    Node* left;
    Node* right;
};

int main() {
    std::stack<int> depth;
    depth.push(1);
    depth.push(2);
    depth.push(3);
    depth.pop();

    Node d{4, nullptr, nullptr};
    Node e{5, nullptr, nullptr};
    Node b{2, &d, &e};
    Node c{3, nullptr, nullptr};
    Node a{1, &b, &c};

    std::stack<Node*> todo;
    todo.push(&a);
    int sum = 0;
    while (!todo.empty()) {
        Node* cur = todo.top();
        todo.pop();
        sum += cur->value;
        if (cur->right) todo.push(cur->right);
        if (cur->left) todo.push(cur->left);
    }
    std::cout << sum << std::endl;
    return 0;
}
