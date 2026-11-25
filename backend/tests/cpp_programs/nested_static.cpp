struct N { int v; N* next; };
void f() { for (int i = 0; i < 1; i++) { static N* ns = nullptr; if (!ns) ns = new N{5, nullptr}; } }
int main() {
  f();
  return 0;
}
