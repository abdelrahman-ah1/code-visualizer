// std::vector<bool> is bit-packed: libstdc++'s gdb printer yields plain Python bools for its
// elements, not gdb.Values. The tracer used to crash on that ('bool' object has no attribute
// 'type'). Its elements must be drawn as real bools.
#include <vector>

int main() {
    std::vector<bool> flags(4, false);
    flags[1] = true;
    flags[3] = true;
    return flags[1] ? 0 : 1;
}
