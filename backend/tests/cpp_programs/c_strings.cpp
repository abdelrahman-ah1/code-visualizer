#include <cstdio>
int main() {
  const char* words[] = {"apple", "pear", "", "fig"};
  const char* one = "kiwi";
  char buf[8] = "ab";
  std::printf("%s %s\n", words[0], one);
  return buf[0] == 'a' ? 0 : 1;
}
