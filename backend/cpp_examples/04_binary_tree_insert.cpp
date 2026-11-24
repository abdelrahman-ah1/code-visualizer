struct T { int k; T* left; T* right; };
T* insert(T* r, int k) {
    if (!r) return new T{k, nullptr, nullptr};
    if (k < r->k) r->left = insert(r->left, k); else r->right = insert(r->right, k);
    return r;
}
int main() {
    T* root = nullptr;
    int keys[3] = {5, 2, 8};
    for (int i = 0; i < 3; i++) root = insert(root, keys[i]);
    return root->k;
}
