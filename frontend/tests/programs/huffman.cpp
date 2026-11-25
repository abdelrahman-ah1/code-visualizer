#include <iostream>
#include <queue>
#include <vector>
#include <string>

using namespace std;

struct Node {
    char ch;
    int freq;
    Node *left, *right;
    Node(char c, int f, Node* l = nullptr, Node* r = nullptr)
        : ch(c), freq(f), left(l), right(r) {}
};

struct Compare {
    bool operator()(Node* a, Node* b) {
        return a->freq > b->freq;
    }
};

Node* buildHuffmanTree(const vector<pair<char, int>>& items) {
    priority_queue<Node*, vector<Node*>, Compare> pq;
    for (const auto& item : items) {
        pq.push(new Node(item.first, item.second));
    }

    while (pq.size() > 1) {
        Node* left = pq.top(); pq.pop();
        Node* right = pq.top(); pq.pop();
        pq.push(new Node('\0', left->freq + right->freq, left, right));
    }

    return pq.empty() ? nullptr : pq.top();
}

void printTree(Node* root, int depth = 0) {
    if (!root) return;
    cout << string(depth * 2, ' ')
         << (root->ch ? string(1, root->ch) : "*")
         << " (" << root->freq << ")\n";
    printTree(root->left, depth + 1);
    printTree(root->right, depth + 1);
}

int main() {
    vector<pair<char, int>> freq = {
        {'a', 5}, {'b', 9}, {'c', 12},
        {'d', 13}, {'e', 16}, {'f', 45}
    };

    Node* root = buildHuffmanTree(freq);
    printTree(root);

    return 0;
}
