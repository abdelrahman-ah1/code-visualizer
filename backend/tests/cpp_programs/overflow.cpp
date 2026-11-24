int main() {
    int a[3] = {1, 2, 3};
    int total = 0;
    for (int i = 0; i <= 3; i++) total += a[i];
    int* h = new int[2];
    h[2] = 7;
    delete[] h;
    return total > 100;
}
