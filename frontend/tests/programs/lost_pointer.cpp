// GENERATED broken program: loses the last pointer to a live typed node.
#include <iostream>
struct TreeNode { int key; int value; TreeNode* left; TreeNode* right; };
int main() {
  TreeNode* root = new TreeNode{50, 500, nullptr, nullptr};
  root->left = new TreeNode{30, 300, nullptr, nullptr};
  root->right = new TreeNode{70, 700, nullptr, nullptr};
  root->left->left = new TreeNode{20, 200, nullptr, nullptr};
  root->left = nullptr;          // BUG: the only pointer to node 30 (and to its child 20) is overwritten
  std::cout << root->key << "\n";
  return 0;
}
