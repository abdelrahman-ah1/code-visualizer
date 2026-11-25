struct N { int v; N* next; };
int main() {
  N* head = nullptr;
  for (int i = 0; i < 150; i++) { head = new N{i, head}; }
  N* cut = head; for (int i = 0; i < 60; i++) cut = cut->next;
  N* lost = cut->next; cut->next = nullptr;   // 89 live nodes now unreachable from head, never freed
  lost = nullptr;
  return 0;
}
