#include <iostream>
struct Point { int x; int y; };
int total = 0;
int sum(int* a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
int main() {
    int arr[4] = {5, 1, 4, 2};
    Point p = {3, 4};
    Point* q = &p;
    q->x = 9;
    int* heap = new int[3];
    for (int i = 0; i < 3; i++) heap[i] = i * i;
    total = sum(arr, 4) + sum(heap, 3);
    double ratio = total / 4.0;
    char letter = 'A';
    bool ok = total > 10;
    std::cout << total << " " << ratio << "\n";
    delete[] heap;
    return 0;
}
