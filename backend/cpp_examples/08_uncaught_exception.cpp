#include <stdexcept>
int check(int x) {
    if (x > 2) throw std::out_of_range("too big");
    return x;
}
int main() {
    int a = check(1);
    int b = check(5);
    return a + b;
}
