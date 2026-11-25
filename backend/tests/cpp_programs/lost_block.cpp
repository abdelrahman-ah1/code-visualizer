int main() {
  void* p = new int(5);   // held only as void*: no type is ever seen for this block
  p = nullptr;            // and now nothing points at it
  return p == nullptr ? 0 : 1;
}
