int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int main() {
    int r = fact(4);
    return r == 24 ? 0 : 1;
}
