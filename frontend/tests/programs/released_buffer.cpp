#include <vector>
#include <string>
int main() {
    std::vector<int> v = {1, 2, 3};
    v.push_back(4);
    std::string name = "a string that is longer than the small-string buffer";
    int n = (int)v.size() + (int)name.size();
    return n > 0 ? 0 : 1;
}
