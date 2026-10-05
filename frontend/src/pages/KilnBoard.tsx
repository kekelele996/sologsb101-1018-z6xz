/**
 * /kiln 制胎间：坯胎入库单 + 含水率复测 + 两头对账挂起
 * 这头管制胎间数据：开入库单、逐次复测含水率；
 * 排道次前髹涂那头只认最近一次复测结论。编号 / 结论对不上的挂起在本页等人判。
 * 消费 KilnReceipt、MoistureTest、Reconciliation，并对照 Body、Coat；
 * 复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useKilnStore } from '@/stores/kilnStore';
import {
  MOISTURE_LIMIT_PCT,
  MOISTURE_VERDICT_COLOR,
  MOISTURE_VERDICT_LABEL,
  MOISTURE_VERDICT_OPTIONS,
  createEmptyReceiptDraft,
  createEmptyTestDraft,
  judgeMoisture,
  type KilnReceipt,
  type KilnReceiptDraft,
  type MoistureTest,
  type MoistureTestDraft,
  type MoistureVerdict,
} from '@/types/kiln';
import {
  HOLD_REASON_COLOR,
  HOLD_REASON_LABEL,
  HOLD_STATUS_LABEL,
  type Reconciliation,
} from '@/types/reconcile';

const RECEIPT_FILTER_KEYS = ['verdict'] as const;

export default function KilnBoard() {
  const { message } = AntdApp.useApp();
  const [receiptForm] = Form.useForm<KilnReceiptDraft>();
  const [testForm] = Form.useForm<MoistureTestDraft>();
  const [resolveForm] = Form.useForm<{ resolver: string; resolveNote: string }>();

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const receipts = useKilnStore((state) => state.receipts);
  const tests = useKilnStore((state) => state.tests);
  const holds = useKilnStore((state) => state.holds);
  const reconcileError = useKilnStore((state) => state.reconcileError);
  const createReceipt = useKilnStore((state) => state.createReceipt);
  const updateReceipt = useKilnStore((state) => state.updateReceipt);
  const removeReceipt = useKilnStore((state) => state.removeReceipt);
  const createTest = useKilnStore((state) => state.createTest);
  const updateTest = useKilnStore((state) => state.updateTest);
  const removeTest = useKilnStore((state) => state.removeTest);
  const resolveHold = useKilnStore((state) => state.resolveHold);
  const runReconcile = useKilnStore((state) => state.runReconcile);

  const [receiptEditing, setReceiptEditing] = useState<KilnReceipt | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [testEditing, setTestEditing] = useState<MoistureTest | null>(null);
  const [testReceipt, setTestReceipt] = useState<KilnReceipt | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [resolving, setResolving] = useState<Reconciliation | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);

  const url = useFilterQuery(RECEIPT_FILTER_KEYS);
  const verdictFilter = url.values.verdict ?? [];

  const bodyCodeSet = useMemo(() => new Set(bodies.map((body) => body.code.trim())), [bodies]);

  /** 入库单 → 最近复测结论，便于列表直接展示 */
  const latestByCode = useMemo(() => {
    const map = new Map<string, MoistureTest>();
    [...tests]
      .sort((a, b) => (a.testDate === b.testDate ? a.createdAt - b.createdAt : a.testDate < b.testDate ? -1 : 1))
      .forEach((test) => map.set(test.code, test));
    return map;
  }, [tests]);

  const heldCount = useMemo(
    () => new Set(coats.filter((coat) => coat.held).map((coat) => coat.bodyId)).size,
    [coats],
  );
  const passCount = receipts.filter((receipt) => latestByCode.get(receipt.code)?.verdict === 'pass').length;
  const openHoldCount = holds.filter((hold) => hold.status === 'hold').length;

  const filteredReceipts = useMemo(() => {
    const keyword = url.keyword.trim();
    return receipts.filter((receipt) => {
      if (keyword.length > 0 && !`${receipt.code}${receipt.maker}${receipt.note}`.includes(keyword)) return false;
      if (verdictFilter.length > 0) {
        const verdict = latestByCode.get(receipt.code)?.verdict ?? 'none';
        if (!verdictFilter.includes(verdict)) return false;
      }
      return true;
    });
  }, [receipts, tests, url.keyword, verdictFilter, latestByCode]);

  const openReceiptCreate = (): void => {
    setReceiptEditing(null);
    receiptForm.setFieldsValue(createEmptyReceiptDraft());
    setReceiptOpen(true);
  };

  const openReceiptEdit = (receipt: KilnReceipt): void => {
    setReceiptEditing(receipt);
    receiptForm.setFieldsValue({
      code: receipt.code,
      inboundDate: receipt.inboundDate,
      initialMoisturePct: receipt.initialMoisturePct,
      maker: receipt.maker,
      note: receipt.note,
    });
    setReceiptOpen(true);
  };

  const submitReceipt = async (): Promise<void> => {
    const values = await receiptForm.validateFields();
    const payload: KilnReceiptDraft = { ...values, code: values.code.trim() };
    const result = receiptEditing
      ? await updateReceipt(receiptEditing.id, payload)
      : await createReceipt(payload);
    if (!result.ok) {
      message.error(`制胎间这头写入失败：${result.error}，请重试（髹涂那头不受影响）`);
      return;
    }
    message.success(receiptEditing ? '入库单已更新' : `坯胎 ${payload.code} 已入库`);
    setReceiptOpen(false);
  };

  const openTestCreate = (receipt: KilnReceipt): void => {
    setTestEditing(null);
    setTestReceipt(receipt);
    testForm.setFieldsValue(createEmptyTestDraft(receipt.id, receipt.code));
    setTestOpen(true);
  };

  const openTestEdit = (test: MoistureTest): void => {
    const receipt = receipts.find((item) => item.id === test.receiptId) ?? null;
    setTestEditing(test);
    setTestReceipt(receipt);
    testForm.setFieldsValue({
      receiptId: test.receiptId,
      code: test.code,
      testDate: test.testDate,
      moisturePct: test.moisturePct,
      verdict: test.verdict,
      tester: test.tester,
      note: test.note,
    });
    setTestOpen(true);
  };

  const watchedMoisture = Form.useWatch('moisturePct', testForm) as number | undefined;

  const submitTest = async (): Promise<void> => {
    const values = await testForm.validateFields();
    // 结论以含水率上限为准，复测人可改，但默认随含水率联动
    const payload: MoistureTestDraft = { ...values, verdict: judgeMoisture(values.moisturePct) };
    const result = testEditing ? await updateTest(testEditing.id, payload) : await createTest(payload);
    if (!result.ok) {
      message.error(`复测记录写入失败：${result.error}，请重试`);
      return;
    }
    message.success(
      payload.verdict === 'pass'
        ? `${payload.code} 复测达标，压着的待涂道次将放回可编排`
        : `${payload.code} 复测未达标，待涂道次继续压着等`,
    );
    setTestOpen(false);
  };

  const openResolve = (hold: Reconciliation): void => {
    setResolving(hold);
    resolveForm.setFieldsValue({ resolver: '', resolveNote: '' });
    setResolveOpen(true);
  };

  const submitResolve = async (): Promise<void> => {
    if (!resolving) return;
    const values = await resolveForm.validateFields();
    const result = await resolveHold(resolving.issueKey, values.resolver, values.resolveNote);
    if (!result.ok) {
      message.error(`判定写入失败：${result.error}，请重试`);
      return;
    }
    message.success('已记录人工判定');
    setResolveOpen(false);
  };

  const receiptColumns: ColumnsType<KilnReceipt> = [
    { title: '坯胎编号', dataIndex: 'code', width: 120, sorter: (a, b) => a.code.localeCompare(b.code), render: (code: string) => <Tag color="#8c2f1f">{code}</Tag> },
    {
      title: '髹涂台账',
      key: 'linked',
      width: 110,
      render: (_v, record) =>
        bodyCodeSet.has(record.code) ? <Tag color="green">已建档</Tag> : <Tag color="orange">查无编号</Tag>,
    },
    { title: '入库日期', dataIndex: 'inboundDate', width: 110, sorter: (a, b) => a.inboundDate.localeCompare(b.inboundDate) },
    { title: '初测含水率', dataIndex: 'initialMoisturePct', width: 110, render: (value: number) => `${value}%` },
    {
      title: '最近复测',
      key: 'latest',
      render: (_v, record) => {
        const latest = latestByCode.get(record.code);
        if (!latest) return <Typography.Text type="secondary">暂无复测</Typography.Text>;
        return (
          <Space size={6}>
            <Tag color={MOISTURE_VERDICT_COLOR[latest.verdict]}>{MOISTURE_VERDICT_LABEL[latest.verdict]}</Tag>
            <span>{latest.testDate} · {latest.moisturePct}%</span>
          </Space>
        );
      },
    },
    { title: '制胎工', dataIndex: 'maker', width: 100, render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openTestCreate(record)}>
            复测
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openReceiptEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除入库单"
            description="同时删除该单的复测记录；髹涂那头的胎体道次不动。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void removeReceipt(record.id).then((result) => {
                if (result.ok) message.success('入库单已删除');
                else message.error(`删除失败：${result.error}，请重试`);
              })
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const testColumns: ColumnsType<MoistureTest> = [
    { title: '复测日期', dataIndex: 'testDate', width: 120, sorter: (a, b) => b.testDate.localeCompare(a.testDate) },
    { title: '坯胎编号', dataIndex: 'code', width: 120, render: (code: string) => <Tag color="#8c2f1f">{code}</Tag> },
    { title: '含水率', dataIndex: 'moisturePct', width: 100, render: (value: number) => `${value}%` },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 100,
      render: (value: MoistureVerdict) => <Tag color={MOISTURE_VERDICT_COLOR[value]}>{MOISTURE_VERDICT_LABEL[value]}</Tag>,
    },
    { title: '复测人', dataIndex: 'tester', width: 100, render: (value: string) => value || '—' },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openTestEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该次复测"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void removeTest(record.id).then((result) => {
                if (result.ok) message.success('复测记录已删除');
                else message.error(`删除失败：${result.error}，请重试`);
              })
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const holdColumns: ColumnsType<Reconciliation> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (status: Reconciliation['status']) => (
        <Tag color={status === 'hold' ? 'red' : 'default'}>{HOLD_STATUS_LABEL[status]}</Tag>
      ),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      width: 130,
      render: (reason: Reconciliation['reason']) => (
        <Tag color={HOLD_REASON_COLOR[reason]}>{HOLD_REASON_LABEL[reason]}</Tag>
      ),
    },
    { title: '坯胎编号', dataIndex: 'code', width: 120, render: (code: string) => (code ? <Tag color="#8c2f1f">{code}</Tag> : '—') },
    { title: '说明', dataIndex: 'detail' },
    {
      title: '判定',
      key: 'resolution',
      width: 180,
      render: (_v, record) =>
        record.status === 'resolved' ? (
          <Space direction="vertical" size={0}>
            <Typography.Text type="secondary">{record.resolver}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.resolveNote || '—'}</Typography.Text>
          </Space>
        ) : (
          <Button size="small" type="primary" ghost icon={<SafetyCertificateOutlined />} onClick={() => openResolve(record)}>
            人工判定
          </Button>
        ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>制胎间 · 坯胎入库与含水率复测</h2>
          <p>
            开坯胎入库单并逐次复测含水率（上限 {MOISTURE_LIMIT_PCT}%）；髹涂那头排道次前只认最近一次复测，
            没达标的压着等，复测过了自动放回。编号或结论对不上的先挂起等人判。
          </p>
        </div>
        <Space wrap>
          <Button onClick={() => void runReconcile().then((r) => (r.ok ? message.success('对账完成') : message.error(`对账失败：${r.error}`)))}>
            重新对账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openReceiptCreate}>
            坯胎入库
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="入库单" value={receipts.length} suffix="张" tone="primary" />
        <StatBadge label="复测达标坯胎" value={passCount} suffix="具" tone="success" icon={<CheckCircleOutlined />} />
        <StatBadge label="复测记录" value={tests.length} suffix="次" tone="info" />
        <StatBadge label="压着等的坯胎" value={heldCount} suffix="具" tone="warning" />
        <StatBadge label="挂起等人判" value={openHoldCount} suffix="条" tone="danger" />
      </div>

      {reconcileError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`对账这头失败：${reconcileError}（制胎间与髹涂那头的数据照旧，可点「重新对账」只重试这头）`}
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'receipts',
            label: `入库单（${filteredReceipts.length}）`,
            children: (
              <>
                <FilterBar
                  keyword={url.keyword}
                  onKeywordChange={url.setKeyword}
                  selects={[
                    {
                      key: 'verdict',
                      label: '最近复测',
                      options: [
                        { value: 'pass', label: '达标' },
                        { value: 'fail', label: '未达标' },
                        { value: 'none', label: '暂无复测' },
                      ],
                    },
                  ]}
                  values={url.values}
                  onValuesChange={url.setValues}
                  onReset={url.reset}
                  keywordPlaceholder="搜索编号 / 制胎工 / 备注…"
                />
                <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
                  {filteredReceipts.length === 0 ? (
                    <EmptyPanel
                      title={receipts.length === 0 ? '制胎间还没有坯胎入库单' : '当前筛选下没有入库单'}
                      description="坯胎出库晾坯前先开入库单，晾到含水率达标并复测后，髹涂那头才能上头道漆。"
                      actionText="坯胎入库"
                      onAction={openReceiptCreate}
                      size="small"
                    />
                  ) : (
                    <Table<KilnReceipt>
                      rowKey="id"
                      size="small"
                      pagination={false}
                      columns={receiptColumns}
                      dataSource={filteredReceipts}
                      expandable={{
                        expandedRowRender: (record) => {
                          const rowTests = tests
                            .filter((test) => test.receiptId === record.id)
                            .sort((a, b) => b.testDate.localeCompare(a.testDate));
                          return rowTests.length === 0 ? (
                            <Typography.Text type="secondary" style={{ padding: '8px 0', display: 'block' }}>
                              该坯胎还没有复测记录，点上方「复测」登记第一次含水率复测。
                            </Typography.Text>
                          ) : (
                            <Table<MoistureTest>
                              rowKey="id"
                              size="small"
                              pagination={false}
                              columns={testColumns}
                              dataSource={rowTests}
                            />
                          );
                        },
                      }}
                    />
                  )}
                </Card>
              </>
            ),
          },
          {
            key: 'holds',
            label: `对账挂起（${openHoldCount}）`,
            children: (
              <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
                {holds.length === 0 ? (
                  <EmptyPanel
                    title="没有挂起记录"
                    description="两边按坯胎编号对账一致；编号对不上、复测结论矛盾时会自动挂到这里等人判。"
                    size="small"
                  />
                ) : (
                  <Table<Reconciliation>
                    rowKey="issueKey"
                    size="small"
                    pagination={false}
                    columns={holdColumns}
                    dataSource={holds}
                    rowClassName={(record) => (record.status === 'hold' ? 'gb-row-hold' : '')}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      <Modal
        open={receiptOpen}
        title={receiptEditing ? `编辑入库单 ${receiptEditing.code}` : '坯胎入库'}
        onCancel={() => setReceiptOpen(false)}
        onOk={() => void submitReceipt()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={receiptForm} layout="vertical" preserve={false}>
          <Form.Item
            name="code"
            label="坯胎编号"
            rules={[{ required: true, message: '请输入坯胎编号，与髹涂台账一致，如 LQ-2404' }]}
            extra="两边按此编号对账；编号对不上会先挂起等人判。"
          >
            <Input placeholder="LQ-2404" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="inboundDate" label="入库日期" rules={[{ required: true }]}>
                <Input type="date" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="initialMoisturePct"
                label="初测含水率（%）"
                rules={[{ required: true }]}
                extra={`晾至 ≤ ${MOISTURE_LIMIT_PCT}% 复测达标方可上漆`}
              >
                <InputNumber min={0} max={60} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="maker" label="制胎工">
                <Input placeholder="如：赵师傅" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="note" label="备注">
                <Input placeholder="泥料 / 窑批 / 晾坯位" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        open={testOpen}
        title={testEditing ? `编辑复测 ${testEditing.code}` : `含水率复测 · ${testReceipt?.code ?? ''}`}
        onCancel={() => setTestOpen(false)}
        onOk={() => void submitTest()}
        okText="保存复测"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={testForm} layout="vertical" preserve={false}>
          <Form.Item name="receiptId" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="code" hidden>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="testDate" label="复测日期" rules={[{ required: true }]}>
                <Input type="date" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="moisturePct" label="实测含水率（%）" rules={[{ required: true }]}>
                <InputNumber min={0} max={60} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Alert
            style={{ marginBottom: 12 }}
            type={judgeMoisture(watchedMoisture ?? MOISTURE_LIMIT_PCT) === 'pass' ? 'success' : 'error'}
            showIcon
            message={
              judgeMoisture(watchedMoisture ?? MOISTURE_LIMIT_PCT) === 'pass'
                ? `含水率 ${watchedMoisture ?? MOISTURE_LIMIT_PCT}% ≤ ${MOISTURE_LIMIT_PCT}%，复测达标，待涂道次放回可编排`
                : `含水率 ${watchedMoisture ?? MOISTURE_LIMIT_PCT}% ＞ ${MOISTURE_LIMIT_PCT}%，未达标，待涂道次继续压着等`
            }
          />
          <Form.Item name="verdict" label="复测结论">
            <Select
              disabled
              options={[...MOISTURE_VERDICT_OPTIONS]}
              placeholder="随实测含水率自动判定"
            />
          </Form.Item>
          <Form.Item name="tester" label="复测人">
            <Input placeholder="如：周敏" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="如：表面返潮 / 晾透可上漆" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={resolveOpen}
        title={resolving ? `人工判定 · ${resolving.code || HOLD_REASON_LABEL[resolving.reason]}` : ''}
        onCancel={() => setResolveOpen(false)}
        onOk={() => void submitResolve()}
        okText="提交判定"
        cancelText="取消"
        destroyOnClose
      >
        {resolving ? (
          <>
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={resolving.detail} />
            <Form form={resolveForm} layout="vertical" preserve={false}>
              <Form.Item name="resolver" label="判定人" rules={[{ required: true, message: '请署名' }]}>
                <Input placeholder="如：工序管理员" />
              </Form.Item>
              <Form.Item name="resolveNote" label="判定意见" rules={[{ required: true, message: '请填写责任归属 / 处理意见' }]}>
                <Input.TextArea rows={3} placeholder="如：确认为未晾透先上漆，责任归制胎间，坯胎返晾 / 道次返工…" />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
