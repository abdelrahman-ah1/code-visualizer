int main() {
  int* arr = new int[5]{1, 2, 3, 4, 5};
  int* single = new int(42);
  arr = nullptr;
  single = nullptr;     // both blocks are leaked: typed pointers were seen, then dropped
  return 0;
}
