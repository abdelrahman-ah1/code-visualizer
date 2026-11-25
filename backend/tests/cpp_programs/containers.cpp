#include <map>
#include <list>
#include <set>
#include <string>
struct Node { int v; Node* next; };
int main() {
  std::map<int, Node*> m; m[1] = new Node{9, nullptr}; m[2] = new Node{8, nullptr};
  std::map<std::string, int> ages; ages["bo"] = 3;
  std::list<Node*> l; l.push_back(new Node{1, nullptr});
  std::set<int> st = {3, 1, 2};
  return 0;
}
