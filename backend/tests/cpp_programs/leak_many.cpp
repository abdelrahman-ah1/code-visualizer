struct N { int v; };
int main() {
  for (int i = 0; i < 400; i++) { N* n = new N{i}; n = nullptr; }   // 400 leaked blocks: more than one snapshot can draw
  return 0;
}
