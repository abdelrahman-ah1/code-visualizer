#include <cstdlib>
#include <cstring>
int main() {
    for (int i = 0; i < 100000; i++) { char* p = (char*)malloc(100000000); if (p) memset(p, 1, 100000000); }
    return 0;
}
