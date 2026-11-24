#include <string>
#include <vector>
int main() {
    std::string name = "Ada";
    std::vector<int> v = {1, 2, 3};
    v.push_back(4);
    int n = (int)v.size();
    return n == 4 ? 0 : 1;
}
