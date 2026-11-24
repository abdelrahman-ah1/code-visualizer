#include <stdexcept>
int check(int x) {
    if (x > 2) throw std::runtime_error("too big");
    return x;
}
int main() {
    int r = 0;
    try {
        r = check(5);
    } catch (const std::exception& e) {
        r = -1;
    }
    return r == -1 ? 0 : 1;
}
