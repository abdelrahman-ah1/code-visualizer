#include <iostream>
struct TreeNode { int key; int value; TreeNode* left; TreeNode* right; };
struct HashTree { TreeNode* buckets[4]; int count; };

TreeNode* insertNode(TreeNode* root, int key, int value, bool* added) {
  if (!root) { *added = true; return new TreeNode{key, value, nullptr, nullptr}; }
  if (key == root->key) root->value = value;
  else if (key < root->key) root->left = insertNode(root->left, key, value, added);
  else root->right = insertNode(root->right, key, value, added);
  return root;
}
void put(HashTree* t, int key, int value) {
  bool added = false;
  int b = key % 4;
  t->buckets[b] = insertNode(t->buckets[b], key, value, &added);
  if (added) t->count++;
}
TreeNode* removeNode(TreeNode* root, int key, bool* removed) {
  if (!root) return nullptr;
  if (key < root->key) { root->left = removeNode(root->left, key, removed); return root; }
  if (key > root->key) { root->right = removeNode(root->right, key, removed); return root; }
  TreeNode* keep = root->left ? root->left : root->right;   // this sketch only removes nodes with at most one child
  delete root;
  *removed = true;
  return keep;
}
void erase(HashTree* t, int key) {
  bool removed = false;
  int b = key % 4;
  t->buckets[b] = removeNode(t->buckets[b], key, &removed);
  if (removed) t->count--;
}
int main() {
  HashTree t{};
  int keys[] = {5, 9, 13, 2, 6, 10, 8, 4, 3};
  for (int i = 0; i < 9; i++) put(&t, keys[i], keys[i] * 10);
  put(&t, 9, 99);
  erase(&t, 13);
  erase(&t, 6);
  std::cout << t.count << "\n";
  return 0;
}
