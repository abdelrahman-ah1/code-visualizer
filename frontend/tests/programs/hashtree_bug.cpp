struct TreeNode { int key; TreeNode* left; TreeNode* right; };
int main() {
  TreeNode* root = new TreeNode{5, nullptr, nullptr};
  root->left = new TreeNode{2, nullptr, nullptr};
  delete root->left;                 // bug: root->left is left dangling
  return root->left->key;            // reads freed memory
}
