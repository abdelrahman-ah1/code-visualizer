struct N { int v; N* next; };
N* g_head = nullptr;
static N* s_head = nullptr;
N* keep() { static N* fs = nullptr; if (!fs) fs = new N{3, nullptr}; return fs; }
int main() {
  g_head = new N{1, new N{11, nullptr}};
  s_head = new N{2, nullptr};
  keep();
  N* lost = new N{9, nullptr};
  lost = nullptr;
  return 0;
}
